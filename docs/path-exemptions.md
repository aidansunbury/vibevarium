# Path exemptions (public routes on authed apps)

Every app is behind the auth gateway by default. But real apps need public
surface: a demo page, a webhook/ingestion endpoint, a health check, a public
API. **Admins declare regex path exemptions per app; requests to those paths
skip the gateway's auth requirement and forward directly to the app.**

## The model

- An **exemption** is `(app, pathRegex, authMode)`:
  - `authMode: "none"` — fully public (a marketing page, a status endpoint)
  - `authMode: "app"` — forwarded without a platform session; the app enforces
    its *own* auth (a webhook secret, an HMAC signature, an ingestion token)
- Exemptions live in the control plane's registry as **app config** (rows
  editable by admins via the GUI/API), not in the app's code — an admin grants
  public surface without a redeploy.
- The app's own routes still authorize themselves per `docs/identity.md`; an
  exemption only lifts the *platform's* gateway requirement, never the app's.

## Where enforcement lives

Two layers, matching how apps are reached:

1. **Router / gateway layer** — when a request hits `<app>.vibevarium.com` (or
   the meta-MCP gateway), the routing decision checks the app's exemption list
   first: match → forward without the platform session; no match → require the
   session as usual.
2. **App middleware** — the template's auth middleware gets the same list
   baked in at deploy time (defense in depth): a request that arrives with no
   session is allowed only on exempt paths. This keeps an app honest even if
   it's reached directly (bypassing the router), per the "sensitive apps"
   caveat in docs/mcp-auth.

The two share one source of truth: the registry row. The router reads it live;
the app's middleware gets it as deploy-time config (an env/binding from
scaffold), so both enforce the same policy without the app calling home.

## Rules that keep it safe

- **Default-deny**: no exemptions ⇒ everything requires auth. Exemptions are
  per-app, explicit, and auditable (a registry event per add/remove).
- **Narrowest match**: admins write regexes; the UI warns on overly broad
  patterns (`/.*`, `/(?!webhook).*`) and shows example paths that would match.
- **Exemptions never widen**: an exempt path that isn't declared by the app
  itself (no route) just 404s at the app — exemption opens the gate, it
  doesn't invent a handler.
- **Ingestion endpoints** (`authMode: "app"`) get a per-endpoint secret the
  platform generates and stores (SecretsProvider); the app's template
  middleware verifies it — so "public webhook" doesn't mean "unauthenticated."

## Examples

- `demo.vibevarium.com/` fully public → exemption `^/$|^/demo/.*`, mode `none`
- `hooks.vibevarium.com/stripe` → exemption `^/stripe$`, mode `app` (Stripe
  signature checked by the app with a platform-stored secret)
- `api.vibevarium.com/public/status` → exemption `^/public/.*`, mode `none`

## v1 scope

Registry rows + GUI editor + router enforcement + template middleware env.
Later: per-exemption rate limits, IP allowlists, and expiry (time-boxed public
links).
