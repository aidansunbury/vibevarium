# State of the project — 2026-11-23

Where Terrarium actually stands: what's live and proven, what's built but not
deployed/polished, the open items, and the design decisions that are locked vs
still open. Read this to re-orient; the other docs hold the depth.

## What is live and proven (production, vibevarium.com)

- **Auth server**: Logto self-hosted at `https://auth.vibevarium.com` (RDS-backed,
  docker on EC2). End users (`testUser`, `aidansunbury`, `clitest1`) are distinct
  from the admin-console account. `allowTokenExchange` enabled (Option C path open).
- **Control plane**: `https://platform.vibevarium.com` — GUI behind real
  auth-code login (session cookie), RDS Postgres for the store, secrets from AWS
  Secrets Manager (zero secret env vars on the box), TanStack GUI.
- **Two authed apps**: `tickets.vibevarium.com` + `notes.vibevarium.com` —
  real GitHub repos (terrarium-sandbox), Cloudflare Worker + Durable Objects +
  D1 + React SPA, real OIDC login (per-app client, redirect-on-logout, no
  logged-out state), shadcn frontend.
- **Meta-MCP**: `platform.vibevarium.com/mcp` aggregates both apps (10 tools:
  8 app + 2 directory). `tools/call` forwards the caller's bearer; discovery
  authenticates via a dedicated M2M credential; a killed app fails fast typed
  while the rest of the fleet keeps working.
- **Meta-CLI**: `vibevarium` binary (customizable via `TERRARIUM_CLI_NAME`)
  installable from GH Releases; loopback-PKCE login against live Logto; both
  composed + dynamic-import variants.
- **Scaffold**: `POST /scaffold {name}` → GitHub repo + Cloudflare deploy +
  custom domain + auto-registered per-app Logto OIDC client + discovery, all
  from the live control plane. DELETE tears it all down.
- **Meta-OAuth (connections)**: connect-once → per-app grants → consent screen
  → token vend + unified credential-holding proxy → revocation cascade. Proven
  end-to-end with fake-oauth; **awaits a real GitHub OAuth App for the live proof**
  (the one manual step).

## Design decisions that are LOCKED (do not re-litigate)

- **OIDC-only auth boundary** — no vendor SDKs anywhere; swapping Logto →
  authentik/WorkOS/Clerk is issuer+audience config. (docs/auth.md)
- **Option B′ (executor-style)**: one platform audience (`mcp.vibevarium.com`)
  + per-app audiences; apps accept both. One token opens gateway + all apps.
  Fine-grained per-app grants live in the control-plane DB (revoke = flip a
  row). Option C (RFC 8693 per-child exchange) is the escape hatch for
  sensitive apps. (docs/identity.md, docs/mcp-auth)
- **Identity tiers**: token claims (Tier 0) → domain facts keyed by `sub`
  (Tier 1) → rebuildable identity projection (Tier 2). Auth server owns
  identity+permissions; apps own facts; permissions never on the user row.
- **Everything is a provider** — git hosting, secrets, auth, deployment are
  swappable interfaces. Deployment is multi-target, not hot-swappable (the
  uniform contract is "an HTTPS endpoint that verifies OIDC tokens").
- **One template now** (React SPA + CF Worker + D1, Effect+Drizzle backend);
  templates vary starting shape, never the contract (domain package, Api
  declaration, auth middleware, deploy stack). Options (R2 bucket etc.) are
  feature flags within a template, not new templates.
- **shadcn + Base UI** design system (`@terrarium/ui`), Tailwind v4.
- **TanStack Router + Query + Effect HttpApiClient** typed clients — no raw
  fetch strings in any frontend.
- **Domain as a variable** (`TERRARIUM_DOMAIN=vibevarium.com`) — one knob re-
  domains everything.

## Design decisions still OPEN (to be made)

- **Option C rollout** — when does an app get its own audience + gateway token
  exchange instead of the platform audience? (sensitive apps; not started)
- **CLI distribution** — bun AOT single-binary is the current path (works); keep
  swappable. npm publish later.
- **Workers for Platforms** — purchase-gated; current fallback (standalone
  workers + custom domains) works and is arguably better isolation. Revisit
  only at real scale.
- **Control-plane hosting** — currently EC2+docker; could become Cloudflare
  later (it's a Node+Postgres app, env-driven).

## Built but not yet productionized / deployed

- **Meta-OAuth live proof** — needs the GitHub OAuth App (dashboard step,
  callback `https://platform.vibevarium.com/connections/callback`, creds to
  `GITHUB_OAUTH_CLIENT_ID/SECRET` in SM). The whole flow is built + fake-oauth-proven.
- **Path exemptions** — docs/path-exemptions.md written; regex path exemptions
  (public routes / webhooks) not implemented yet.
- **App M2M credentials** — the integration proxy still uses a placeholder
  shared secret; real per-app client creds from Logto not wired.
- **CONNECTIONS_TOKEN_ENCRYPTION_KEY** — in SM but the box logged "unset" at
  one point (tokens stored unencrypted dev-only warning); verify it's read.

## Known shortcuts (deliberate, on the list to fix)

- **PGlite for local dev only** — prod is on RDS now. Local dev keeps PGlite
  (zero-setup) by design.
- **Discovery static protocol version** — discovery speaks v2026_07_28 to
  cloudflare-mode apps; a stateful app would need negotiation (fine for now).
- **Router worker** — exists from the REAL-SPIKE, adopted into stack state;
  wildcard DNS needs a scoped token if we ever want it (per-app custom domains
  work today, no wildcard needed).
- **compose `version:` key** — obsolete-attribute warning on every docker
  compose call; cosmetic, remove.

## The fix history that hardened it (don't regress these)

- Empty-500 on gated routes: ops bearer gate reuses GUI issuer + platform
  audience when no dedicated ops OIDC (was a defect from guiAuth-only authEnabled).
- Cloudflare state store: per-app stacks + router use local file state (no
  account-pinned R2 store) — app deploys need only Workers/D1 perms.
- web/dist: the materializer ships the built SPA into generated apps.
- Tailwind: `@source "../../../ui/src"` in both frontends so component classes
  are scanned (the unstyled-page bug).
- App registration: public hostname (`<name>.vibevarium.com/mcp`), not
  workers.dev origin.
- Discovery M2M: token endpoint is `${issuer}/token` (issuer already has /oidc).
- Base UI dropdown: Label needs a Group parent (v1.9); 401 session-expired
  check must match Effect HttpApiClient's `reason.response.status` shape.

## Next steps (in rough priority)

1. **Meta-OAuth live proof** — create the GitHub OAuth App (1 dashboard step),
   wire creds to SM, prove `GET /proxy/github/user` returns a real profile.
2. **Path exemptions** — implement regex exemptions (registry rows + GUI editor
   + router/template enforcement) per docs/path-exemptions.md.
3. **Authentik swap-test** — prove the OIDC doctrine + extract the AuthProvider
   adapter interface (the "how truly hot-swappable" test).
4. **App M2M for the proxy** — real per-app client creds replacing the
   placeholder shared secret.
5. **Meta-CLI fresh release** — rebuild with the login flow (the released
   v0.0.1 predates live auth).
6. Later: Option C for sensitive apps, multi-target deploy (AWS Lambda),
   per-app user permissions UI, preview environments, observability.
