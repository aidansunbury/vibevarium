# The MVP (a spike, not a foundation)

A **localhost-runnable** build whose job is to de-risk the hardest parts. We
may throw the whole thing away and start from scratch — learning is the
deliverable, polish is not. That means we build initial versions of the *most
complex* parts, not the easiest vertical slice.

## Locked decisions

- **Control plane**: simple Node app + pnpm, Postgres (Effect + Drizzle, per
  the stack). Runs on localhost. No cloud account required to hack on it.
- **App databases**: Cloudflare **D1 by default**; the database is a provider
  (see [providers.md](./providers.md)) so it's configurable later.
- **Routing**: the scalable option — **Workers for Platforms** (one dispatch
  namespace + a router worker in front of `appname.yourdomain.com`), not
  per-app standalone workers. Zeus proved this shape at 600+ apps.
- **No live credentials**: most cloud/provider credentials won't be available
  for testing. Everything must be drivable locally — emulators, fakes, and
  recorded fixtures (executor's `@executor-js/emulate` approach is the model:
  wire-level stateful fakes with real OAuth flows and request ledgers).

## The hard parts to spike (in scope, all of them)

1. **The template + derived surfaces** — one app template (Effect + Drizzle +
   React, domain skeleton, auth middleware) where `toMcp` / `toHttpApi` /
   `toCli` actually produce a working MCP server, HTTP API + OpenAPI doc, and
   CLI from one Api declaration. Everything else consumes this; it proves the
   central thesis.
2. **The meta-MCP gateway** — registry + discovery fan-out + serving an
   aggregated directory from a store + the dynamic `tools/call` proxy with
   header forwarding and per-child failure isolation. The most novel piece;
   the dynamic proxy is the part no library gives us.
3. **Connections (meta-OAuth)** — connect a provider to the control plane
   once, per-app grant flow with a consent screen, token vending + proxy
   modes. Rip executor's OAuth machinery; the grant layer is ours.
4. **The scaffold flow** — name → repo from template → provision DB → register
   OIDC client → inject secrets → deploy → register in the registry → live.
   The control plane's core workflow.
5. **The mega-CLI** — composed `toCli` subtrees from published domain
   packages, including the dynamic-import-from-manifest variant, with one SSO
   login flowing through every call.

## Explicitly still out

Multi-target deploy (Cloudflare only) · multiple templates · per-app user
permissions (all apps company-wide behind SSO) · preview environments · real
observability.

## What "done" looks like for a spike

Each spike answers its question: does the derived-surface story hold up? Is
the dynamic proxy tractable? Is the consent flow buildable without fighting
the auth server? Write the answer down, keep or bin the code, move on.

## Spike status (2026-11-20): all five hardest parts PROVEN

All demos green, all `tsrs` typechecks clean. Each package has a `SPIKE.md`
with proof outputs and findings.

1. **Template + derived surfaces** (`packages/template`) — WORKS. One
   `Domain.Api` declaration → MCP server + HTTP API with `/openapi.json` +
   CLI. Caveats: CLI talks to a separate `/rpc` mount, not the `toHttpApi`
   routes; zero-input commands need a `--json` workaround; auth wired via
   `requireAuth` seam (`TERRARIUM_AUTH=off` to disable).
2. **Meta-MCP gateway** (`packages/control-plane`) — WORKS. Discovery serves
   from the PGlite store, never a live fan-out. Dynamic `tools/call` proxy
   forwards `Authorization` headers. Killed app → stale-marked tools stay
   listed, calls fail in ~5ms typed, rest of fleet unaffected. Effect MCP
   lacks `removeTool` (visibility workaround documented).
3. **Connections / meta-OAuth** (`packages/connections` + `packages/fake-oauth`)
   — WORKS. Real auth-code + PKCE flow against a fake provider; consent
   screen gated by real OIDC; token vending AND credential-holding proxy;
   revocation cascades. Open: scope growth, cross-process refresh locking,
   app authn, consent CSRF.
4. **Scaffold flow** (`packages/control-plane/src/scaffold`) — WORKS.
   `POST /scaffold {name}` → generated app (own process, own OIDC audience,
   local-git repo via pluggable `GitProvider`) → registered → discovered →
   callable through the gateway with the user's bearer forwarded. Survives
   control-plane `SIGKILL`.
5. **Mega-CLI** (`packages/cli`) — WORKS. Composed (type-safe) and
   dynamic-import-from-manifest variants; one `platform login` (dev-issuer)
   sends the same bearer through every call. Upstream finding:
   `toCli({ headers })` in beta.87 doesn't put headers on the HTTP request —
   workaround + recommended fix in `packages/cli/SPIKE.md`.

Known spike shortcuts (deliberate): PGlite instead of docker Postgres
(daemon unavailable); wrapper-not-fork for generated apps; static
`DISCOVERY_TOKEN` instead of per-app M2M; no React frontend yet.
