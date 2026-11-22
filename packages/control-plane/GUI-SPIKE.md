# Control-plane GUI spike (`web/`)

## Verdict

A React + Vite SPA served by the control plane itself. v1 screens: **app
gallery** (registered apps with status/URL/last-seen), **app detail**
(discovered tools, stale markers, delete), **scaffold** (name → `POST
/scaffold` → repo/app/hostname result), and an **integrations** panel
(register integrations, grant/revoke app access, view the proxy audit). Auth
gate: a login button mints a dev-issuer token; every API call carries it;
`GET /whoami` shows the `CurrentActor`. The actor identity appears in the
header.

## Run it

```sh
# one command for the whole local platform (issuer + control plane + app + discovery):
pnpm --filter @terrarium/control-plane dev          # → http://127.0.0.1:4100/

# GUI iteration against a running control plane:
pnpm --filter @terrarium/control-plane gui:dev      # vite dev server on :4101, /apps etc. proxied to :4100

# production-ish: build the SPA; the server serves web/dist at /
pnpm --filter @terrarium/control-plane gui:build && pnpm --filter @terrarium/control-plane start
```

The server mount is `src/gui.ts`: static files from `GUI_DIR` (default
`web/dist`) with an `index.html` fallback for client routes, registered last so
every API route wins (FindMyWay ranks static routes above the `/*` fallback
anyway). With no `web/dist` the mount is inert.

## Auth seams

- **Now (real Logto)**: `Log in` navigates to the server's `GET /auth/login`,
  which 302s to the hosted Logto `/oidc/auth` (authorization code + PKCE S256,
  RFC 8707 resource `https://mcp.vibevarium.com`, `prompt=consent` so
  `offline_access` yields a refresh token). `GET /auth/callback` exchanges the
  code with the GUI secret, verifies the ID token, and sets an httpOnly
  SameSite=Lax session cookie (`terrarium_session`, HMAC-signed, server-side
  in-memory Map). The SPA holds no token — every API call is `credentials:
  "same-origin"`. `GET /auth/me` returns the actor for the header; `POST
  /auth/logout` destroys the session and redirects to Logto end-session.
  Implemented in `src/auth-flow.ts`; wired in `src/server.ts` (ops gates accept
  the session cookie OR a bearer token) and `src/main.ts` (env:
  `LOGTO_GUI_APP_ID/SECRET`, `LOGTO_ISSUER`, `CONTROL_PLANE_BASE_URL`). Secret
  locally from repo-root `.env`; production AWS Secrets Manager
  `/terrarium/prod/logto-gui-app-secret`. Proof: `scripts/logto-auth-demo.ts`.
- **Dev fallback**: without `LOGTO_GUI_APP_SECRET` the auth flow is not mounted;
  the control plane falls back to bearer-token `requireAuth` when
  `CONTROL_PLANE_ISSUER` is set, else dev-open (header shows "auth off").

## What the GUI calls

| Screen | Endpoints |
| --- | --- |
| App gallery | `GET /whoami`, `GET /apps`, `POST /discover` |
| App detail | `GET /directory`, `DELETE /apps/:name` |
| Scaffold | `POST /scaffold` |
| Integrations | `GET/POST /integrations`, `GET/POST/DELETE .../grants`, `GET .../audit` |

All of those are gated by `requireAuth` when `CONTROL_PLANE_ISSUER` is set
(ops routes in `server.ts`, scaffold routes in `scaffold/index.ts`,
integration admin in `integrations/routes.ts`); `/health` and the static SPA
stay public.

## Screenshot description

Running `pnpm --filter @terrarium/control-plane dev` and opening
`http://127.0.0.1:5100/` (alternate port during verification) shows:

- **Header**: "Terrarium control plane — app gallery" on the left; on the right
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

- No routing library — screens are conditional panels, not URLs.
- No MCP playground; the gateway is exercised by demos/CLI, not the GUI.
- The integrations panel is admin-shaped (raw forms), not the consent UX of
  docs/connections.md — that second-order consent screen is a separate product
  surface.
- No tests, per spike convention; proof is the running stack above.
