# Control-plane GUI (`web/`)

## Verdict

A React + Vite SPA served by the control plane itself, on the locked frontend
stack: **TanStack Router** (file routes) + **TanStack Query** (server state) +
an **Effect-`HttpApiClient` typed client** (no hand-rolled fetch strings).
Routes: `/` app **gallery** (registered apps with status/URL/last-seen, run
discovery), `/apps/$name` **app detail** (discovered tools, stale markers,
delete + per-app secrets), `/scaffold` (name → `POST /scaffold` → result), and
one `/connections` page (OAuth providers/grants, statically configured proxied
secrets and grants, webhook sources/subscriptions, audit). The root route (`__root`) is the auth
guard: its `beforeLoad` resolves `GET /auth/me`; auth-on with no session shows
a sign-in card (matching the existing UX), auth-off dev mode renders straight
through. The actor identity is in the header.

## The frontend stack

- **Routing: TanStack Router (file routes, `@tanstack/router-plugin`).**
  `web/src/routes/__root.tsx` holds the shell (header, nav, actor menu) and
  the auth gate; one file per screen under `web/src/routes/`. The plugin
  generates `src/routeTree.gen.ts` at dev/build.
- **Server state: TanStack Query v5.** `useQuery` holds the registry /
  directory / integrations / connections data; `useMutation` runs scaffold /
  delete / discovery / grant / revoke with `invalidateQueries` on the affected
  keys. No `useState`/`useEffect` for server data.
- **The typed client** (`web/src/api.ts`): the control plane's routes are
  HAND-WRITTEN (`HttpRouter` in `src/server.ts`, `scaffold/`, `integrations/`,
  `connections/`), not a domain `HttpApi` — so unlike the app template there's
  no server declaration to reuse. Instead `api.ts` declares the exact
  request/response surface as a typed `effect/http-api/HttpApi`
  (Schema-validated, mirroring the routes one-to-one) and hands it to
  `effect/http-api/HttpApiClient.make` over a cookie-first `FetchHttpClient`.
  The endpoints are the typed contract; when a route changes, update its
  endpoint here (the routes are the source of truth — the control plane has
  no `/openapi.json`). A 401 maps to `UnauthenticatedError`.

## Run it

```sh
# one command for the whole local platform (issuer + control plane + app + discovery):
pnpm --filter @vibevarium/control-plane dev          # → http://127.0.0.1:4100/

# GUI iteration against a running control plane:
pnpm --filter @vibevarium/control-plane gui:dev      # vite dev server on :4101, /apps etc. proxied to :4100

# production-ish: build the SPA; the server serves web/dist at /
pnpm --filter @vibevarium/control-plane gui:build && pnpm --filter @vibevarium/control-plane start
```

The server mount is `src/gui.ts`: static files from `GUI_DIR` (default
`web/dist`) with an `index.html` fallback for client routes, registered last so
every API route wins (FindMyWay ranks static routes above the `/*` fallback
anyway). With no `web/dist` the mount is inert.

## Auth seams

- **OIDC authorization code + PKCE**: `GET /auth/login` redirects to the
  configured Casdoor or WorkOS issuer. Pending PKCE transactions live in the
  `session_transactions` table and are atomically consumed on callback, so a
  deploy between login and callback does not break sign-in. `GET /auth/callback`
  creates a row in `sessions` and sets the opaque, HMAC-signed
  `vibevarium_session` cookie. Raw cookie IDs are never stored; tokens and PKCE
  verifiers use versioned AES-256-GCM ciphertext under the stable
  `SESSION_ENCRYPTION_KEY` resolved through `SecretsProvider`.
- **Independent token/session lifetimes**: the absolute login lifetime defaults
  to seven days (`GUI_SESSION_TTL_MS`) and matches the cookie `Max-Age`.
  `GuiAuth.getSession` refreshes near-expiry access tokens through discovery,
  persists rotated credentials, preserves omitted replacement tokens, and
  serializes same-process refreshes plus cross-task database row locks.
  Invalid grants delete the session; transient issuer failures preserve it and
  produce a temporary 503 instead of a login redirect loop. Logout deletes the
  durable row. The SPA never receives access, ID, or refresh tokens.
- **Dev fallback**: without GUI auth configuration the flow is not mounted; the
  control plane falls back to bearer-token `requireAuth` when
  `CONTROL_PLANE_ISSUER` is set, else dev-open (header shows "auth off").

## What the GUI calls

| Route | Endpoints |
| --- | --- |
| `/` gallery | `GET /auth/me`, `GET /apps`, `POST /discover` |
| `/apps/$name` detail | `GET /directory`, `DELETE /apps/:name` |
| `/scaffold` | `POST /scaffold` |
| `/connections` (also integrations + events) | `GET /integrations`, `GET/POST/DELETE .../grants`, `GET .../audit`, `GET /events/sources`, `GET/POST/DELETE /events/subscriptions`, `GET /events/deliveries` |
| `/connections` OAuth | `GET /connections/providers`, `GET /connections`, `POST /connections/start`, `POST /connections/revoke`, `GET /grants`, `POST /grants/revoke`, `GET /integrations/:provider/audit` |

All of those are gated by `requireAuth` when `CONTROL_PLANE_ISSUER` is set
(ops routes in `server.ts`, scaffold routes in `scaffold/index.ts`,
integration admin in `integrations/routes.ts`); `/health` and the static SPA
stay public.

## Screenshot description

Running `pnpm --filter @vibevarium/control-plane dev` and opening
`http://127.0.0.1:5100/` (alternate port during verification) shows:

- **Header**: "Vibevarium control plane — app gallery" on the left; on the right
  the signed-in actor `Ada (user-ada)` and a "Log out" button (before login: a
  single "Log in (dev issuer)" button, and the body replaced by a
  token-required notice).
- **Registered apps card**: one row — `tickets` with a green **up** badge, URL
  `http://127.0.0.1:5300/mcp`, the discovery timestamp, a "details" button;
  below, "Refresh" and "Run discovery" buttons.
- **App detail** (after clicking details): four tools listed
  (`tickets_TicketsApi_*` with descriptions), status line, a red "Delete app"
  button.
- **Scaffold card**: name input + "Scaffold" button; after a run, the raw JSON
  result (repo URL, app URL, audience, process id, four directory tools).
- **Integrations card**: empty state "No integrations registered", the
  register form (name/base URL/token env), grant form, and the audit `<pre>`
  after clicking "audit" on a row.

## v1 boundaries

- No MCP playground; the gateway is exercised by demos/CLI, not the GUI.
- The integrations panel is admin-shaped (raw forms), not the consent UX of
  docs/connections.md — that second-order consent screen is a separate product
  surface.
- GUI auth persistence, refresh, replay, and HTTP restart flows are covered by
  `src/auth-flow.test.ts`; broader visual/playground work remains manual.
