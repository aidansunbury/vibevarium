# Connections — the meta-OAuth layer, for real

`docs/connections.md` is the spec. This is the implementation report: what was
built on the control plane, how the flows run, the token lifecycle, and the one
manual step (creating the GitHub OAuth App) that turns the whole thing live
against GitHub.

The local spike (`packages/connections/`) proved the model against a standalone
server. This module **ports that proven logic into the control plane's Effect
service style** — `packages/control-plane/src/connections/` — and merges the
proxy with the existing integrations proxy so there is ONE proxy mechanism.

## The model

Two rows, matching Auth0 Token Vault / Nango / Pipedream Connect:

- **Connection** — user ↔ provider. The stored credential (access + refresh
  tokens, granted scopes, expiry), owned by the user, held by the control
  plane. The control plane never uses them itself.
- **Grant** — app ↔ connection. The user's decision that app X may use their
  provider connection. Revocable independently; revoking the *connection* kills
  every grant on it (one place to cut everything off).

```
oauth_providers   (name, display_name, authorize_url, token_url, userinfo_url,
                   api_base_url, client_id_ref, client_secret_ref, default_scopes,
                   response_mode)
connections       (id, user_sub, provider, provider_account_sub/label,
                   access_token 🔒, refresh_token 🔒, granted_scopes, expires_at,
                   status: active | revoked | requires_reauth)
connection_grants (id, app_id, provider, connection_id, owner_sub, scopes,
                   status: pending | approved | revoked, approved_at)
oauth_sessions    (state, user_sub, provider, pkce_verifier, redirect_uri,
                   requested_scopes, expires_at)   -- 15-min TTL, single-use
```

**Secrets never live in the DB.** Provider OAuth client id/secret are stored as
*references* (`client_id_ref`, `client_secret_ref`) resolved through the
`SecretsProvider` seam — env vars locally, AWS Secrets Manager in prod (the
boot loader maps `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` /
`CONNECTIONS_TOKEN_ENCRYPTION_KEY`). Tokens **are** stored, but encrypted at
rest with **AES-256-GCM** (`v1:<iv>:<tag>:<ciphertext>`, the spike's envelope)
under `CONNECTIONS_TOKEN_ENCRYPTION_KEY` — also from the SecretsProvider. With
the key unset the store is plaintext and the control plane logs a loud dev-only
warning.

## The flows

### Connect (user → control plane → provider), once per provider

```
user          control plane                 provider (GitHub/fake-oauth)
 │ POST /connections/start {provider}              │
 │  (GUI session or bearer)                        │
 │◄── {authorization_url}──┐                       │
 │  state + PKCE verifier stored (oauth_sessions)  │
 │──GET authorize_url─────────────────────────────►│
 │                     (provider consent screen)   │
 │◄────────────redirect to /connections/callback── │
 │  code + state (query or form_post)              │
 │    exchange code + PKCE verifier ──────────────►│
 │◄────────── access + refresh tokens ─────────────│
 │  fetchProviderIdentity → upsert connection (🔒) │
```

One OAuth client registration per provider covers the whole company — the
control plane IS the OAuth client. State + PKCE verifier live in
`oauth_sessions` (TTL 15 min, deleted on use — replay-proof).

### Grant + consent (app → user's connection)

```
app                     control plane                     user
 │ POST /grants/request        │                            │
 │ {provider, scopes}          │                            │
 │ (app credential: x-vibevarium-app/secret)                 │
 │◄── {grant_id, consent_url} ─│                            │
 │──redirect user to consent_url───────────────────────────►│
 │                       GET /grants/consent?grant=…        │
 │                     (GUI session REQUIRED — 401/302 else)│
 │            "App X wants your GitHub (read:user)"         │
 │           [Approve] [Deny]  →  POST /grants/decision     │
 │              binds grant → user's connection             │
```

Consent binds only when the user already has an **active** connection for the
provider whose granted scopes **cover** the request — otherwise `409
connection_required` (with a connect link) or `409 missing_scopes`. Approving
supersedes any earlier approved grant for the same (app, provider): exactly one
usable grant per app+provider (the spike's rule, kept because vend has no
per-user audience dimension yet).

### Use: vend vs proxy

- **`POST /vend {provider}`** (app credential) — returns the raw provider
  access token. Lower latency, the app holds a credential, weaker audit.
- **`ANY /proxy/:provider/*`** (app credential, or user bearer +
  `x-vibevarium-on-behalf-of-app`) — the control plane attaches the token and
  forwards to the provider's `api_base_url`. Full per-call audit, instant
  revocation, the app never holds a credential. **Default.**

Both paths share one `usableToken` pipeline: grant check → scope-coverage check
→ refresh-if-needed under a per-connection lock.

## One proxy mechanism (integrations = platform connections)

`/proxy/:target/*` is the single proxy. A target is:

1. a registered **provider connection** (per-user OAuth credential, checked
   against the user's grant) when `target` names a row in `oauth_providers`,
2. else a platform **integration** (company-shared credential from the
   SecretsProvider, checked against the app grant).

Both write to the same `proxy_audit` table (app, target, path, status,
duration). Integrations are exactly "connections with platform-shared
credentials" — the merge is done at the proxy dispatch, not by duplicating
routes.

## Token lifecycle

- **Refresh**: `expires_at - now ≤ 60s` (configurable) → refresh-token grant.
  Providers that rotate refresh tokens get the new one stored; those that
  don't keep the presented one. Serialized per-connection by a partitioned
  semaphore — two concurrent vends can never rotate the same refresh token
  twice (rotation invalidates the first). Response header
  `x-vibevarium-token-refreshed` tells the caller it happened.
- **Revocation**: grant revoke → vend AND proxy return `403 grant_required` on
  the very next call (the check is a live DB read, no cache). Connection
  revoke → every grant on it dies in the same transaction.
- **Provider-side revocation**: refresh fails `invalid_grant` → the connection
  flips to `requires_reauth`, all its grants revoke, and vend/proxy return
  `403 connection_requires_reauth` — the user reconnects to heal.

## The one manual step: the GitHub OAuth App

The GitHub provider is registered at boot from `oauthProviders.github` in
`config/connections.config.ts`. Its client ID and secret resolve through the
configured slugs (env locally, Secrets Manager in prod); missing values are
shown as unconfigured in the UI. Creating that OAuth App is the only provider-dashboard step:

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
   (for an org-owned app: the org's page → Settings → Developer settings).
2. Fill in:
   - **Application name**: `Vibevarium control plane`
   - **Homepage URL**: `https://platform.vibevarium.com`
   - **Authorization callback URL**:
     `https://platform.vibevarium.com/connections/callback`
     (local dev: register a second app or add the URL
     `http://127.0.0.1:4100/connections/callback`)
3. **Generate a new client secret.**
4. Put the pair where the SecretsProvider finds them:
   - local: `GITHUB_OAUTH_CLIENT_ID=…` and `GITHUB_OAUTH_CLIENT_SECRET=…` in the
     repo-root `.env`;
   - prod: SM secrets `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`
     under `/vibevarium/prod/`.
5. Also set `CONNECTIONS_TOKEN_ENCRYPTION_KEY` (any 32+ byte random string;
   `openssl rand -base64 32`) so tokens are encrypted at rest.
6. Keep the `github` entry in `connections.config.ts` and restart the control
   plane. Its configured secret slugs are validated before startup.

Then the live flow is: sign into the GUI → Connections panel → **Connect** on
GitHub → approve on GitHub's screen → back on the control plane. An app with a
grant can then call `GET /proxy/github/user` and receive the user's GitHub
profile, or `POST /vend {provider:"github"}` for the raw token.

> Checked the repo-root `.env` at build time: `GITHUB_OAUTH_CLIENT_ID/SECRET`
> were NOT present, so the live GitHub proof awaits this one dashboard step.
> Everything up to GitHub's own screens is proven end-to-end with fake-oauth
> below, and the GitHub path differs only in URLs + the identity shape
> (`id`/`login` instead of OIDC `sub` — handled in `oauth.ts`).

## The fake-oauth proof (what IS proven, end-to-end)

`scripts/connections-demo.ts` boots the REAL control plane (PGlite, bearer
auth on via the dev issuer — the same `consentActor` gate the GUI session
cookie feeds), fake-oauth as the provider, and drives every endpoint:

- **connect**: real PKCE authorize URL → scripted provider consent → real code
  exchange → connection row (encrypted at rest), listed via `GET /connections`.
- **grant**: app requests; consent screen 401s with no user actor, renders
  "App metrics-dashboard wants your Datadog (read:metrics)" for the user;
  approve binds it (`owner_sub = user-ada`).
- **vend**: raw RS256 provider token returned; a DIRECT provider API call with
  it returns metrics.
- **proxy**: `/proxy/datadog/metrics` forwards with the token attached,
  `x-vibevarium-grant-id` set; after the provider's 5s token TTL the proxy
  transparently rotates (`x-vibevarium-token-refreshed: true`,
  `refreshTokenRotations: 1` in the provider snapshot).
- **revoke**: grant revoke → vend+proxy `403 grant_required` immediately;
  re-approve, connection revoke → all grants die.
- **audit**: every proxied call (200s and 403s) is a `proxy_audit` row.

Run it: `node --experimental-strip-types packages/control-plane/scripts/connections-demo.ts`

## GUI

`web/src/routes/connections.tsx` composes OAuth providers and grants, shared
proxied-secret grants, and webhook sources/subscriptions on one page. OAuth
connect full-page-redirects to the provider authorize URL. The consent screen
itself is server-rendered HTML at `/grants/consent` (no React; requires the user's session).

## Not done

- **Multi-account connections** — one connection per (user, provider); a
  GitHub org switcher or a second account would need keyed connections.
- **Scope union / re-consent on growth** — grants requiring scopes beyond the
  connection's granted set fail `409 missing_scopes`; widening the connection
  means a fresh connect, not an incremental consent.
- **ID-JAG** (`draft-ietf-oauth-identity-assertion-authz-grant`) — enterprise
  identity assertion instead of the user consent screen. Track the draft;
  executor's `oauth-ema.ts` is the reference when it matures.
- **App auth is the pre-M2M placeholder** (`x-vibevarium-app` + shared secret),
  same as the integrations proxy. When apps get real OIDC M2M client
  credentials, `/grants/request` + `/vend` + `/proxy` swap the header check for
  a platform-audience bearer check — the grant model doesn't change.
- **Per-user vend audience** — vend returns the one approved grant per
  (app, provider). Multi-user apps will want grants keyed (app, provider,
  owner) with the app naming the user at vend time.
