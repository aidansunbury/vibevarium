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
