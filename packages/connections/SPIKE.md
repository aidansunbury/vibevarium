# Connections spike — meta-OAuth

## Verdict

The hard flow works locally without faking either identity protocol. A real dev-issuer OIDC JWT identifies Ada; the control plane performs authorization-code + PKCE against a real fake-provider OAuth server; a second, second-order consent binds an app to Ada's existing connection. Both direct token use and credential-holding proxying work, including refresh-token rotation and revocation.

The final demo proves this sequence:

1. Ada (`user-ada`, OIDC) starts one Datadog connection.
2. Fake Datadog shows its own provider consent/account picker and returns a one-time authorization code with the original `state` via `form_post`.
3. The control plane verifies PKCE at the provider token endpoint, reads `/userinfo`, and stores an encrypted access/refresh token pair.
4. `metrics-dashboard` (Basic app-credential stub) requests `read:metrics`.
5. Ada's OIDC bearer is required at the control-plane consent URL. The HTML says: **“App metrics-dashboard wants your Datadog (read:metrics)”**.
6. Approval produces an approved grant. The app can vend the raw RS256 provider token and call `/api/v1/metrics` directly, or call `/proxy/datadog/metrics` without seeing a token.
7. A short provider token TTL plus a 4-second refresh skew forces a rotation before the proxy call.
8. Revoking the grant makes both vend and proxy return 403. Approving another grant and then revoking the connection also makes both return 403; the connection revocation updates every grant on that connection in the same transaction.

## Run it

From the repo root:

```sh
pnpm --dir packages/fake-oauth test
pnpm --dir packages/connections test
pnpm --dir packages/connections demo

pnpm exec tsrs --noEmit -p packages/fake-oauth/tsconfig.json
pnpm exec tsrs --noEmit -p packages/connections/tsconfig.json
```

`demo` prints a JSON report containing the provider and control-plane HTML transitions. Authorization codes, state, PKCE challenges, and access tokens are redacted only in that report; the flow itself uses the real values.

For a manually browsable three-process-in-one composition (dev issuer, fake Datadog, and connections):

```sh
pnpm --dir packages/connections start
# defaults: OIDC :4010, connections :4020, fake Datadog :4040
```

To run just a provider:

```sh
PROVIDER_NAME=github PORT=4050 \
REDIRECT_URIS=http://127.0.0.1:4020/connections/callback \
pnpm --dir packages/fake-oauth start
```

Programmatic callers can start any number of providers with `startFakeOAuthProvider({ name, port: 0, ... })`; each has independent keys, codes, refresh tokens, users, and API state.

## HTTP surface

User/OIDC routes use `@terrarium/auth`'s `requireAuth` and `CurrentActor`:

- `POST /connections/start { provider, scopes? }` → provider authorization URL. `scopes` is optional and exists for reconnecting with a wider set.
- `GET|POST /connections/callback` → one-time state redemption, code + PKCE exchange, userinfo lookup, connection upsert.
- `GET /grants/consent?grant=...` → second-order consent HTML.
- `POST /grants/decision` (`grant`, `decision=approve|deny`) → bind the pending request to the current user and connection, or delete the pending request on denial.
- `POST /grants/revoke { grantId }`
- `POST /connections/revoke { connectionId }` → revoke the connection and all its grants.

App routes use a replaceable HTTP Basic credential stub (`Basic base64(appId:secret)`):

- `POST /grants/request { appId, provider, scopes }` → pending grant + consent URL.
- `POST /vend { appId, provider }` → raw provider access token (never the refresh token), scopes, expiry, grant id, and whether this call refreshed it.
- `ANY /proxy/:provider/*` → validate grant/scopes, refresh if needed, replace the app credential with the provider bearer, and forward the request.

`GET /connections/callback` is unauthenticated because the browser returns without Ada's bearer; its random, one-time, expiring state row carries the user identity established at `/connections/start`.

## Schema (Drizzle + embedded PGlite)

`src/schema.ts` is the source of truth; `src/store.ts` applies idempotent spike DDL on boot.

### `oauth_clients`

One control-plane OAuth registration per provider:

- `name` (PK), `display_name`
- `authorize_url`, `token_url`, `userinfo_url`, `api_base_url`
- `client_id`, `client_secret`
- `default_scopes`, `response_mode`
- timestamps

This is provider catalog/config data, not per-provider flow code.

### `connections`

One row per `(user_sub, provider)` in this spike:

- `id` (UUID PK), `user_sub`, `provider` (FK)
- `provider_account_sub`, `provider_account_label`
- `access_token`, nullable `refresh_token`
- `granted_scopes`, nullable epoch-ms `expires_at`
- `status`: `active`, `revoked`, or `requires_reauth`
- timestamps; unique `(user_sub, provider)`

When `tokenEncryptionKey` is configured, each token is independently sealed as `v1:<iv>:<tag>:<ciphertext>` with AES-256-GCM. The demo enables it and `store.test.ts` checks that raw rows do not contain either token. This is only an encryption seam, not a production secret vault.

### `grants`

- `id` (UUID PK), `app_id`, `provider` (FK)
- nullable `connection_id` (FK) and `owner_sub` while pending; both are bound at approval
- `scopes`
- `status`: `pending`, `approved`, or `revoked` (deny deletes the pending row)
- `approved_at` and timestamps

To avoid an unsafe ambiguous choice in the deliberately small `vend { appId, provider }` API, approval revokes any previous approved grant for the same `(app, provider)`. Production needs an explicit user/grant/audience binding instead of this single-active-grant restriction.

### `oauth_sessions`

- random `state` (PK), `user_sub`, `provider`
- PKCE verifier, exact redirect URI, requested scopes
- epoch-ms expiry and creation time

State is deleted with `DELETE ... RETURNING` on callback, so callbacks are one-time. Starting a flow lazily sweeps that user's expired sessions.

## What I ripped from Executor

Patterns came from the MIT-licensed `oauth-helpers.ts`, `oauth-service.ts`, `oauth-client.ts`, and `connection.ts`; no Executor dependency or code package was vendored.

- Random OAuth state and PKCE verifier, S256 challenge, exact redirect/client matching at the provider.
- 15-minute OAuth session TTL and one-time callback-state routing.
- `expiresAt = now + expires_in`, refresh-before-expiry skew (60 seconds by default; shortened-token demo uses 4 seconds).
- A refresh response without a new refresh token retains the old one; fake-oauth always rotates so replay/rotation is exercised too.
- Granted scopes are persisted at connect and refresh, rather than assuming the provider granted everything requested.
- Connection identity label, expiry, and health/status live on the credential row.
- OAuth client registration is independent provider config; connections fill that template.

The grant/consent/vend/proxy layer is Terrarium-specific. A small per-process promise chain serializes refreshes per connection, preventing concurrent local calls from presenting the same rotating refresh token. This is not a cross-replica lock.

## Consent UX shape

The provider consent and Terrarium consent are intentionally different screens:

- **Provider consent** establishes user ↔ provider. Fake Datadog shows the OAuth client, scopes, and a provider-user picker, issues a real code, then auto-submits it to the control plane.
- **Terrarium consent** establishes app ↔ existing connection. It shows app id, provider display name, requested scopes, connected provider-account label, and the OIDC-signed-in user. It performs no new provider round-trip.

The pending grant is user-agnostic until the authenticated consent screen. Approval binds it to the current user and their connection. Missing scopes fail with HTTP 409 and `missing_scopes`; reconnecting through `/connections/start` with a wider `scopes` array updates the connection's granted set. Deny simply deletes the pending request.

This spike implements one provider per consent screen. Combining multiple provider requests into one consent remains a composition/UX task.

## Token vending vs proxy — observed tradeoffs

| Observation | Vend | Proxy |
| --- | --- | --- |
| Credential exposure | App receives the raw RS256 access token and can call Datadog directly. | App sends only its app credential; the provider token stays in the control plane. |
| Latency/path | One fewer control-plane hop on each provider API call. | Every API call traverses the control plane. |
| Refresh | Control plane refreshes before vending, but the app chooses how long to retain the vended token. | Control plane can refresh on every near-expiry call; lifecycle is centralized. |
| Revocation | A revoked grant stops future vends, but an already-vended token remains valid at the provider until expiry/revocation there. | The next call immediately gets 403; no provider round-trip occurs. |
| Audit/policy | Direct provider traffic is invisible to Terrarium. | Natural point for request audit, path/method policy, and scope enforcement. |
| Implementation cost | Small response, but client now has secret handling and token caching concerns. | More HTTP edge cases. This spike forwards any method but buffers request/response bodies rather than streaming them. |

The demo's `x-terrarium-token-refreshed: true` proxy header and provider snapshot (`refreshTokenRotations: 1`, `apiRequests: 2`) make the refresh path visible without exposing the provider credential.

## Open questions / deliberately not production-ready

1. **Scope union:** connect wide once, or reconnect on demand? The spike detects missing scopes and supports a wider reconnect, but has no automatic “reconnect then resume this grant” orchestration. Refresh downscoping makes subsequent vend/proxy calls fail 403.
2. **Per-app audience/user binding:** `{ appId, provider }` is insufficient when one app serves many users or connections. Should apps present a grant id, a user-context assertion, or an app-scoped token exchange? The single-active-grant restriction is only a spike guardrail.
3. **Refresh races:** the local mutex works in one process. A real deployment needs transactional row leasing/version checks or a dedicated token lifecycle worker, with explicit behavior after a refresh succeeds upstream but the local write fails.
4. **App authentication:** HTTP Basic is a stub. Replace it with OIDC/JWT client credentials, key rotation, audience checks, and potentially sender-constrained tokens.
5. **Consent security:** production needs the platform's browser session integration, CSRF protection, signed/short-lived request handles, and an app redirect allowlist. The UUID grant handle and 15-minute expiry are not a complete browser session design.
6. **Vault/audit:** AES-GCM demonstrates encrypted storage, not key management. Executor's `SecretRef` direction, per-grant audit events, and operational key rotation are still needed.
7. **Proxy policy:** registration currently trusts the API base URL and forwards any path beneath it. Real integrations need method/path allowlists, body limits/streaming, redirect policy, and audit redaction.
8. **Multiple accounts:** one connection per user/provider and one active grant per app/provider are intentional simplifications, not the desired final domain limits.
9. **Failure recovery:** provider `invalid_grant` marks the connection `requires_reauth` and revokes its grants. Transport/5xx failures remain retryable, but there is no background repair or health-check worker.
