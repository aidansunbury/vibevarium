# Auth

We do **not** build an auth server. We pick a standalone, open-source OIDC
provider, and we keep the boundary at standard OIDC so the pick is reversible.

## The one rule that matters

**Depend on OIDC primitives only, never the vendor SDK.**

- App middleware (shipped in the template) does exactly three things: fetch the
  issuer's JWKS from the discovery document, verify the JWT (`iss`, `aud`,
  expiry), map claims to an actor.
- Flows used are all standard:
  - Web apps → authorization code + PKCE
  - CLI → loopback-redirect PKCE (or device flow where supported)
  - Gateway → child discovery (`tools/list`) → client credentials (M2M)
- Enterprise SSO (Okta, Entra, SAML) is a connector configured **inside** the
  auth server. The platform never sees SAML.

Hold this line and swapping providers — Logto → Zitadel, or to a hosted
WorkOS/Clerk later — is changing an issuer URL and audience in config. The
moment a vendor SDK (`logto-react`, management APIs) enters app code, the
lock-in we avoided comes back.

## Candidate providers

Actively maintained, open-source, no Keycloak-style Java bloat. All speak OIDC.

| Project | ~Stars | Stack | License | Best for |
| --- | --- | --- | --- | --- |
| **Logto** | 14.7k | TypeScript | MPL-2.0 | Closest stack match; modern CIAM; API resources + M2M + enterprise SSO connectors |
| **Zitadel** | 15.3k | Go | AGPL-3.0 | Multi-tenant B2B; built-in orgs and audit logs. AGPL needs care if this ever becomes a product |
| **Ory (Hydra + Kratos)** | 17.6k | Go | Apache-2.0 | Headless, API-first OAuth/OIDC; full UI control; most battle-tested |
| **Authentik** | 25.9k | Python/Go | MIT (core) | Visual flow-based IdP; strong for internal tools |
| **Authelia** | 29.2k | Go | Apache-2.0 | OIDC + reverse-proxy auth gate — closest to the Zeus "gate" topology |
| **Casdoor** | 14.5k | Go/React | Apache-2.0 | Single-binary all-in-one IAM with RBAC/ABAC |
| **Pocket ID** | 10.4k | Go | BSD-2-Clause | Ultra-light passkey-only OIDC. No M2M/enterprise-SSO story — likely insufficient alone |

### DCR: the meta-MCP forcing function (assessed 2026-11-23)

The meta-MCP (`platform.vibevarium.com/mcp`) must let **arbitrary MCP clients**
(Claude, Cursor, Executor, future agents) connect with zero manual setup —
same shape as Linear/Railway/Notion MCP. The mechanism is **RFC 7591 Dynamic
Client Registration**: the client discovers `registration_endpoint` from the
OAuth metadata, POSTs its metadata, gets a `client_id`, then walks a normal
auth-code + PKCE flow. Nobody creates an OAuth app by hand. (The MCP spec,
2026-07-28 revision, deprecates DCR in favor of **CIMD** — `client_id` as an
HTTPS URL hosting the client's metadata — but keeps DCR as a MAY for
backwards compatibility; DCR is the interoperable path today, CIMD the
forward path.)

Verified against each candidate:

| Project | DCR (RFC 7591) | Open (unauthenticated) registration | CIMD | Verdict for meta-MCP |
| --- | --- | --- | --- | --- |
| **Logto** | ❌ none (confirmed on live `auth.vibevarium.com`: no `registration_endpoint`, `POST /oidc/register` → unrecognized route) | — | ❌ | Cannot serve arbitrary clients. Clients must be created via Management API (a control-plane DCR shim is possible but is one more thing to own). |
| **Zitadel** | ✅ since v4.17.0 (2026-08) | ✅ open mode, per-instance security toggle | 🚧 draft (PR #12316) | ⚠️ DCR-created clients default to **opaque** access tokens, not JWT — JWKS-verifying middleware rejects them until a reconciler flips `accessTokenType` via Management API (issue #12658, open). Mature Terraform, real B2B orgs. AGPL. |
| **Authentik** | ✅ since 2026.8 | ❌ **authenticated only** — registration requires a bearer with the `goauthentik.io/oidc/dcr` scope | ❌ | ❌ Eliminated: DCR is **Enterprise-licensed**, and authenticated DCR structurally cannot serve unannounced clients. |
| **Ory Hydra** | ✅ mature; OpenID-certified "Dynamic OP" profile | ✅ `/oauth2/register` public when enabled; RFC 7592 management too | ❌ | Best protocol citizen; recent releases fix MCP-client-specific DCR bugs. ⚠️ Headless: no login/consent UI — Hydra + Kratos + consent app = 3 services vs Logto's 1 container. |
| **Casdoor** | ✅ RFC 7591 + 7592 | ✅ per-org `dcrPolicy: open` switch, documented explicitly for MCP clients | ✅ since 2026-10 | Best feature fit: open DCR **and** CIMD, resource indicators (RFC 8707), token exchange, DPoP; Apache-2.0; actively targeting the MCP-auth niche (published Claude/Cursor/ChatGPT connection guides). Risk: youngest ops story (Terraform provider is new). |
| **WorkOS** (hosted) | ✅ | ✅ | — | Hosted escape hatch stays viable. |

**Direction (decided 2026-11-23):** production moves to **WorkOS hosted**
first — it has DCR out of the box, so the meta-MCP can serve arbitrary
clients without standing up a second self-hosted server. **Casdoor stays the
committed open-source, self-hostable option**: a second deployment
(auth.casdoor.vibevarium.com or similar) will run it as the alternative
issuer, proving the OIDC-only swap in both directions (hosted ↔ self-hosted).
Zitadel and Ory Hydra remain documented fallbacks above. The swap test for
each: point one app at the new issuer (issuer + audience config only) and
replay the CLI/MCP login flows.

**WorkOS rollout (in progress):** the control plane selects the provider via
`TERRARIUM_AUTH_PROVIDER=logto|workos`; under `workos` every auth flow (GUI
login, discovery M2M, scaffold client registration, `/mcp` bearer verify)
derives its issuer from `WORKOS_ISSUER` (the AuthKit domain,
`https://<subdomain>.authkit.app` — a custom domain later) and the client id
from `WORKOS_CLIENT_ID` / `WORKOS_API_KEY`. AuthKit is a public client, so
the GUI flow runs secret-less PKCE. The `/mcp` surface is now gated and
publishes both discovery documents (`mcp-gate.ts`): unauthenticated calls get
`401 + WWW-Authenticate: Bearer resource_metadata=...`, exactly the pattern
WorkOS documents for MCP resource servers. Remaining dashboard steps: enable
CIMD (+ DCR for legacy clients) under *Connect → Configuration*, register
`https://mcp.vibevarium.com` as a Resource Indicator, and set
`WORKOS_ISSUER`/`WORKOS_CLIENT_ID`/`WORKOS_API_KEY` in Secrets Manager.

### Starting point: Logto

Reasonable default for this project:

- **TypeScript** — matches the stack.
- **M2M apps** — the gateway→child `tools/list` credential is plain client
  credentials.
- **API resources** — register each child app as a resource → JWT access tokens
  with per-app audiences → per-app permissions (Zeus's per-app grants).
- **Enterprise SSO connectors** — "hook up Okta" is a toggle inside Logto, not
  code we write.
- Stateless verification — children check JWTs against Logto's JWKS endpoint;
  they never call Logto per request.

Caveats: youngest on the list (Ory/Authentik are more scarred-in-production);
if apps ever need real B2B orgs (customers' customers), Zitadel is built around
that and Logto's orgs are thinner; if we want the Zeus-style gate in front of
everything, Authelia is literally that — though the gate matters less here since
each child authorizes itself via middleware anyway.

Don't over-rotate on the choice: if the OIDC-only rule holds, it is reversible.

## Hosted escape hatch

WorkOS and Clerk are both viable later **because** the interface is OIDC, not a
vendor abstraction we wrote. WorkOS AuthKit is OIDC-compatible; Clerk issues
standard JWTs. The migration path is: swap issuer config, keep every app
unchanged.
