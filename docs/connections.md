# Connections — "connect once, grant to many apps"

The problem: four apps each want a user's Datadog via OAuth. Naively that's four
Datadog OAuth app registrations, four consent flows, four token-refresh
implementations. And one app wanting Datadog + GitHub + Slack means three
separate OAuth dances for the user.

The idea: **the control plane is a meta-OAuth layer.**

1. A user connects their Datadog (or GitHub, …) to the **control plane** once.
   One OAuth client registration per provider covers the whole company. The
   control plane holds the tokens and never uses them itself — it just has them.
2. An app declares the connections it wants ("a user's Datadog, also their
   GitHub").
3. The app redirects the user to the control plane. The control plane presents
   one consent screen: "App X wants your Datadog (read) and GitHub (read)". The
   user authorizes — or doesn't.
4. On approval, the app gets a **grant**. Because the user already connected
   both providers, one consent covers all of them — no per-provider round-trips.

Two objects, matching the pattern proven by Auth0 Token Vault, Nango, Pipedream
Connect, and Composio:

- **Connection** — user ↔ provider. The stored credential (access + refresh
  tokens, granted scopes, expiry), owned by the user, held by the control plane.
- **Grant** — app ↔ connection. The user's decision that app X may use their
  Datadog connection. Revocable independently; revoking the *connection* kills
  every grant on it (a feature: one place to cut everything off).

## How an app uses a grant

Two options, per integration policy:

- **Proxy (default)** — the app calls the control plane's integration proxy,
  which attaches the token and forwards. Full audit, instant revocation, the
  app never holds a credential. Same shape as the integration proxies for
  shared company credentials — one mechanism covers both.
- **Token vending (opt-in)** — the app exchanges its grant for the raw access
  token and calls the provider directly. Lower latency, no proxy in the path,
  but weaker audit and the app now holds a credential.

## What would get in the way

Feasible — this is a well-trodden pattern — but the sharp edges:

- **Scope union** — connect with the widest scopes any app might need, or
  re-consent when an app needs more. (Executor records granted scopes on the
  connection and flags reconnect when the declared set grows — steal that.)
- **Refresh lifecycle** — refresh-token rotation, races, revocation, expiry.
  This is the real engineering content of the feature; don't hand-roll it
  casually.
- **The control plane becomes the juiciest target in the company** — every
  user's every token. Encryption at rest, per-grant audit log, strict ACLs on
  the vault, and apps should default to the proxy so tokens rarely leave it.
- **Provider ToS** — some providers restrict redistributing tokens to third
  parties. First-party internal apps under one company are fine; this only
  bites if Terrarium ever becomes multi-customer SaaS.
- **Consent UX is on us** — the auth server (Logto etc.) handles SSO consent,
  but "app X wants your already-connected Datadog" is a second-order consent
  the control plane must render itself. It's a small UI, but it's the product
  surface users will actually see.

## What Executor taught us

[Executor](https://github.com/UsefulSoftwareCo/executor) (MIT, Effect-based)
is the closest existing thing — "configure every integration once with auth and
per-tool policies, then use that one catalog from any agent." Its model
validates ours and names the pieces well:

- **Connection = "THE saved credential — secret, account, and connection are
  one concept," born wired** to one integration, keyed `(owner, integration,
  name)`. Per-member auth (each user connects their own) and team-shared auth
  are both just placement.
- **Auth template vs credential** — an integration declares *how* it
  authenticates (OAuth2 endpoints + scopes); a connection fills that template.
  The OAuth **client** (the registered app) is self-contained and
  integration-independent: "the same app can back connections on whatever
  integrations share that provider" — exactly our one-Datadog-client-for-the-
  company.
- **Secrets never reach the caller** — connections hold a `SecretRef`; a
  provider resolves it at call time, in trusted space, behind a tool-proxy.
  Secret backends are pluggable (encrypted store, 1Password, keychain, WorkOS
  Vault) — our pluggable secret-store provider, same shape.
- **Core owns the OAuth flow** — PKCE, dynamic client registration, token
  exchange + refresh, session TTL, health checks, granted-scope tracking.
  Battle-tested reference code for the hard part.
- **ID-JAG** (`draft-ietf-oauth-identity-assertion-authz-grant`) — an
  enterprise identity assertion *instead of* walking the user through consent.
  The standardized cousin of our consent screen; executor already implements
  it. Worth tracking as it matures.

Where it diverges from us: executor's consumers are **agents calling tools**
through its proxy; our consumers are **apps** — long-lived services that either
call provider APIs directly (vending) or through our HTTP proxy. Its consent is
per-connection; our second-order per-app **grant** doesn't exist there.

## The parts worth ripping out of executor

Executor is MIT-licensed Effect code — no need to embed it as a dependency; we
take the parts we want and build the rest as our own domain model on the
control plane. Shopping list:

- **The OAuth flow machinery** (`oauth-helpers.ts`, `oauth-discovery.ts`,
  `oauth-service.ts`) — PKCE, dynamic client registration, token exchange +
  refresh, session TTL, callback-state routing. The hard, battle-tested part
  and the main reason to look at the code at all.
- **The connection record shape** (`connection.ts`) — born-wired to one
  integration, keyed `(owner, integration, name)`; granted scopes recorded and
  compared against the declared set to force re-consent on scope growth;
  `expiresAt` + health-check verdict persisted on the row.
- **Auth templates** — an integration declares *how* it authenticates (OAuth2
  endpoints + scopes) as data; a connection fills the template. A provider
  catalog as data, not per-provider code.
- **SecretRef + pluggable secret backends** (`provider.ts`, the
  `encrypted-secrets` / `onepassword` / `keychain` / `workos-vault` plugins) —
  connections store a pointer, never the value; resolved at call time, in
  trusted space. Same shape as our pluggable secret-store provider.
- **ID-JAG** (`oauth-ema.ts`) — enterprise identity assertion *instead of* user
  consent (`draft-ietf-oauth-identity-assertion-authz-grant`). The standardized
  cousin of our consent screen; track the draft, steal the implementation when
  it matures.
- **The emulators** (`@executor-js/emulate`) — wire-level stateful fake
  providers with real OAuth flows, real-shaped credentials, and request
  ledgers. How you test this stuff without touching Datadog.

What we build ourselves (the parts that are ours): the **grant** layer
(app ↔ connection consent — doesn't exist in executor), the consent screen UX,
and the vend/proxy endpoints apps actually call. Small domain model:
`ConnectionAdded`, `GrantRequested`, `GrantApproved`, `GrantRevoked` events; a
per-user projection feeding the consent screen; a policy on refresh failure →
re-consent.

Maybe later: executor's spec→tools catalog (OpenAPI/GraphQL/MCP → tools with
auth + policy) is the layer to revisit if the meta-MCP ever needs **agents
calling third-party tools without an app in between**. Skip the kernel/sandbox,
hosts, and app runtime — not our problem.
