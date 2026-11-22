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

- **Now**: "Log in (dev issuer)" hits `${VITE_DEV_ISSUER:-http://127.0.0.1:4010}/dev/token`
  for `aud=control.terrarium.local` and stores the token in localStorage. The
  control plane verifies it when `CONTROL_PLANE_ISSUER` is configured
  (`src/main.ts`); without OIDC config the control plane is dev-open and the
  header shows "auth off".
- **Later (Logto hosted)**: swap the login button for an authorization-code +
  PKCE redirect to the hosted issuer. The seam is one function — `login()` in
  `web/src/api.ts` — plus the vite env vars. The API client, token storage, and
  `requireAuth` server gates don't change.

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
