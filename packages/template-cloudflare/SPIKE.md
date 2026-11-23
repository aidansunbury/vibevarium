# Full-stack template spike — React SPA + Worker domain + D1, one stack

## Verdict

The ONE template now deploys the whole app shape in ONE alchemy stack: a
React SPA built by vite, served as Cloudflare Assets by the same
Effect-native `Cloudflare.Worker` that hosts the Tickets domain model on
Durable Objects, with D1 bound alongside. Local dev runs the real runtime
(`alchemy dev` → workerd with local Durable Objects + local D1) with vite hot
reload in front. The auth seam works: off by default, and with
`TERRARIUM_ISSUER` set, every API surface verifies bearer tokens against the
issuer's JWKS while the SPA discovers the mode from a public status route.

Real deployment left running as the proof:

- Worker: `https://template-fullstack-proof.modal-opencode-test.workers.dev`
- D1: `template-fullstack-proof-data` / `5314e9d3-2a3b-4a68-88c8-aab71df9318f`
- Stack: `TemplateFullstackProof`

```text
GET /                    → 200 text/html (the built SPA, 3 assets uploaded)
GET /tickets/anything    → 200 text/html (SPA fallback for client routes)
GET /health              → ok
GET /auth/status         → {"enabled":false}
GET /d1-health           → {"d1":"bound","rows":[{"value":"tickets-d1"}]}
POST /OpenTicket {"target":"ui-1",...}
                         → {"reply":null,"stream":"Ticket/ui-1","version":1}
GET  /TicketById/ui-1?stream=Ticket%2Fui-1&version=1
                         → {"id":"ui-1","title":"Opened from the deployed UI proof","reporter":"deploy-proof","status":"open"}
POST /CloseTicket {"target":"ui-1","input":{}}
                         → {"reply":null,"stream":"Ticket/ui-1","version":2}
GET  /TicketList/all?stream=Ticket%2Fui-1&version=2
                         → {"tickets":[{"id":"ui-1",...,"status":"closed"}]}
```

## The final app shape

```
packages/template-cloudflare/
├── alchemy.run.ts          # one stack: Cloudflare + DomainCloudflare providers
├── src/
│   ├── TicketsWorker.ts    # THE app: assets + API + MCP + D1 + auth seam
│   ├── auth.ts             # vendored OIDC seam (from @terrarium/auth, no workspace dep)
│   ├── TicketsApi.api.ts   # one Api declaration
│   ├── Tickets.model.ts    # one Model
│   ├── surfaces.ts         # toHttpApi + toMcp over one expose list
│   └── Ticket/             # aggregate, commands, events, rejections, views
├── web/                    # vite + React SPA (own package.json, registry deps only)
│   ├── src/routes/         # TanStack Router file routes: __root (auth guard) + index (tickets)
│   ├── src/api/TicketsApi.ts  # the domain HttpApi surface, vendored (no workspace dep)
│   ├── src/client.ts       # Effect HttpApiClient over that HttpApi + cookie transport
│   └── vite.config.ts      # @tanstack/router-plugin + dev proxy → localhost:1337
├── migrations/0001_app_metadata.sql
└── package.json            # no workspace:* deps — materializes standalone
```

Key: **one Worker, not two**. The example
(`examples/cloudflare-domain`) uses a separate front Worker
(`Website.Foldkit`) with a service binding to the domain Worker. We instead
put `assets` directly on the domain Worker:

```ts
assets: {
  directory: "./web/dist",
  runWorkerFirst: ["/OpenTicket", "/CloseTicket", "/TicketById/*",
                   "/TicketList/*", "/openapi.json", "/rpc*", "/mcp*",
                   "/whoami", "/auth/*", "/health", "/d1-health"],
  notFoundHandling: "single-page-application",
},
```

One origin serves both the SPA and the Api: no CORS, no service binding, one
deploy, one URL to hand out. The `ASSETS` binding is only needed if the
Worker wants to serve files itself; we don't — the asset layer serves
everything not in `runWorkerFirst`, and unmatched paths fall back to
`index.html`.

## The frontend stack (TanStack Router + Query + an Effect client)

The SPA is the reference implementation every generated app copies. Three
decisions, all locked:

- **Routing: TanStack Router (file routes, `@tanstack/router-plugin`).**
  `web/src/routes/__root.tsx` is the auth guard — its `beforeLoad` resolves
  the session (`/auth/status` → `/auth/me`) and hard-navigates to
  `/auth/login` on a 401, so no child route ever renders logged-out. This
  replaces the old boot-`useEffect` bounce. `web/src/routes/index.tsx` is the
  tickets page. The plugin generates `src/routeTree.gen.ts` at dev/build.
- **Server state: TanStack Query v5.** `useQuery` holds the ticket list and
  the session; `useMutation` runs open/close. A mutation is *command →
  read-your-write*: `api.tickets.open` returns the `CommandReceipt`, then the
  mutation reads the list back with `{ atLeast: receipt }` (the
  `?stream&version` query the view needs) and `setQueryData` seeds the list
  cache. No `useState`/`useEffect` for server data anywhere.
- **The typed client: Effect-generated, no hand-rolled fetch.** The frontend
  does NOT hand-write `fetch("/OpenTicket")`. Instead `web/src/api/TicketsApi.ts`
  declares the domain's HTTP surface as an `effect/http-api/HttpApi` — the
  same `DomainHttp.toHttpApi(TicketsApi, { expose })` shape the Worker serves,
  vendored (a generated app has no `workspace:*` deps, so it can't import the
  server's `src/`). `web/src/client.ts` feeds it to
  `effect/http-api/HttpApiClient.make` over a cookie-first `FetchHttpClient`
  (`credentials: "same-origin"`), yielding `client.OpenTicket(...)` /
  `client["TicketList.get"](...)` with request/response types derived from the
  RPC schemas. The transport maps a 401 to `UnauthenticatedError`; the router
  and Query's `retry` both bounce to login on it.

How a generated app gets its client: the scaffold copies `web/` verbatim, so
the vendored `api/TicketsApi.ts` + `client.ts` come along self-contained. When
the domain surface changes, mirror it in `api/TicketsApi.ts` — the OpenAPI doc
at `/openapi.json` is the diff source.

## How scaffold materializes it

`control-plane/src/scaffold/template.ts` copies this package's tree verbatim
(skipping `node_modules`, `.alchemy`, `.git`, `dist`, `*.tsbuildinfo`) and
rewrites only `package.json` (name), `tsconfig.json`, `.env.example`, and the
README title. `web/` comes along as-is — including `web/package.json` with
pure registry deps (react, vite, @vitejs/plugin-react) — so the generated
repo is standalone: `pnpm install && pnpm --dir web install && pnpm deploy`.
`web/dist` is gitignored and rebuilt on every `pnpm deploy` (the deploy
script runs `vite build` first).

Materialization notes for the scaffold owner:

- `web/dist` must stay in the scaffold's skip set (`dist` already is) — the
  built assets are never committed to generated repos.
- The scaffold's generated `tsconfig.json` includes only `["src",
  "alchemy.run.ts"]`; `web/` has its own tsconfig and vite handles its own
  type surface at build. No change needed.
- Auth env (`TERRARIUM_ISSUER`, `TERRARIUM_AUDIENCE`) belongs in the
  generated `.env.example` — already added here.

## Alchemy Assets gotchas (learned the hard way)

1. **`runWorkerFirst` is path-glob, not route-glob.** Rules must start with
   `/` and match the request pathname — `/TicketById/*` covers parameter
   segments; `/rpc*` covers both `/rpc` and `/rpc/...`. A path that matches
   no rule and no asset file gets the SPA fallback (because of
   `notFoundHandling: "single-page-application"`) — so an *unlisted* API
   route silently returns HTML instead of reaching the Worker. Keep the
   worker-first list in `TicketsWorker.ts` in sync with the surfaces.
2. **Assets upload is part of the Worker's script upload.** `alchemy deploy`
   content-hashes the `web/dist` tree; unchanged assets skip the upload. The
   deploy log shows `Uploaded N of 3 assets` — index.html, the JS bundle,
   and its sourcemap.
3. **`vite build` must run before `alchemy deploy`.** The `deploy` script
   chains them (`pnpm --dir web build && alchemy deploy`). `alchemy dev`
   does NOT need the build — workerd serves whatever is in `web/dist` at
   start (stale is fine; vite on :5173 is the dev frontend).
4. **Dev server ports differ from wrangler defaults.** `alchemy dev` serves
   the Worker on **:1337**, not :8787. vite's proxy targets
   `TICKETS_API_ORIGIN ?? http://localhost:1337`.
5. **Two concurrent `alchemy dev` instances briefly SQLite-lock workerd's
   local DO storage** (`SQLITE_BUSY` in the dev log). Harmless once the old
   process is dead, but kill the old dev before restarting.
6. **SPA fallback is hard-coded to `/index.html` at the manifest root** —
   fine here since the SPA is served from the origin root (no `base`).
7. **`domain` prop is independent of assets** — custom hostnames work the
   same (unchanged from the Phase-1 spike).

## Dev mode

Two working modes; (a) is the default and was proven end to end.

**(a) `alchemy dev` + vite — the real runtime, hot frontend.**

```sh
pnpm dev        # workerd: real Durable Objects, local D1, the Worker on :1337
pnpm dev:web    # vite on :5173, proxying the API paths to :1337
```

Proven: SPA served by workerd at `http://localhost:1337/`; `OpenTicket` →
`TicketById?stream=...&version=1` read-your-write; `TicketList` round-trip;
vite proxy serves the same API on :5173. First `atLeast` read after a write
can take a couple of seconds while the view DO wakes — the Api polls; the
client just awaits.

**(b) In-memory Node server — pure domain iteration.** Unchanged, lives in
`packages/template` (`pnpm --filter @terrarium/template demo`). No
Cloudflare anything; for domain-logic work only.

## Auth seam design

Same contract as `packages/template`'s Node server, vendored into
`src/auth.ts` (jose only — no workspace dep) so generated apps are
self-contained:

- **Off by default.** No `TERRARIUM_ISSUER` → all surfaces open,
  `/auth/status` answers `{"enabled":false}`, `/whoami` answers
  `{actor: null, auth: "off"}`.
- **On with two env values.** The stack passes `TERRARIUM_ISSUER` /
  `TERRARIUM_AUDIENCE` into the Worker's `env` (so they're runtime values,
  not build-time). At isolate init the Worker fetches the issuer's discovery
  document once and builds a cached JWKS verifier; `requireAuth` wraps the
  HTTP/MCP/RPC surfaces per request. `aud` mismatch is a hard reject
  (per-audience tokens per docs/identity.md).
- **Public routes:** `/health`, `/d1-health`, `/auth/status` (the SPA's mode
  discovery), the four `/auth/*` flow routes (they ARE the way in), and the
  assets themselves.

Proven locally (the deployed Worker cannot reach a localhost dev-issuer —
auth-on deploys need a reachable issuer):

```text
GET  /auth/status                     → {"enabled":true,"issuer":"http://127.0.0.1:4010"}
GET  /whoami          (no token)      → 401, WWW-Authenticate: Bearer error="invalid_token"
GET  /whoami          (dev token)     → {"actor":{"sub":"user-ada","name":"Ada"},"auth":"on"}
GET  /TicketList/all  (no token)      → 401
POST /OpenTicket      (dev token)     → {"reply":null,"stream":"Ticket/auth-1","version":1}
```

## The real login flow (auth-code + PKCE, session cookie)

Live since Nov 2026 against the hosted Logto tenant. The Worker is the OIDC
client (a Logto **Traditional web** app — confidential, secret server-side);
the browser never holds a token. Mirrored from
`packages/control-plane/src/auth-flow.ts` into `src/auth-flow.ts`.

```text
Browser                     Worker (tickets.vibevarium.com)        Logto
   │ GET / (asset layer serves SPA; no worker code runs)                │
   │ SPA boots → GET /auth/me ───────► 401 (no session)                │
   │ location = /auth/login                                            │
   │ GET /auth/login ─────────────────► 302 /oidc/auth?… ─────────────► │
   │         sets signed terrarium_login cookie (PKCE verifier+state)  │
   │                            │ redirect_uri=<origin>/auth/callback  │
   │                            │ resource=https://mcp.vibevarium.com  │
   │                            │ code_challenge (S256), state         │
   │ ◄────────────────────────────── sign-in + consent (first-party) ──┤
   │ GET /auth/callback?code&state ──► verifies signed pending cookie  │
   │                                 POST /oidc/token (code+verifier   │
   │                                   +client_secret+resource)        │
   │                                 sets terrarium_session cookie ───►│ 302 → /
   │ SPA: /auth/me 200 → app renders (no logged-out state anywhere)    │
   │ API calls carry the cookie; requireAuth verifies the session's    │
   │ embedded platform-audience access token via JWKS, same as bearer. │
```

### Session design: stateless signed cookies (HMAC-SHA256)

Both the **pending login transaction** (`terrarium_login`, 10 min) and the
**session** (`terrarium_session`, token lifetime) are
`base64url(JSON).base64url(HMAC-SHA256(payload))`, keyed by the app client
secret via WebCrypto. Why not the control plane's server-side Map, and not a
Durable Object:

- A Worker has **no isolate affinity** — `/auth/callback` may land on a
  different isolate than `/auth/login`; a Map silently drops the login. A DO
  adds a stateful hop (and cost/latency) to every request just to read a
  session the request already carries.
- Signed cookies survive any isolate, need zero storage, and expire with the
  access token. Revocation story: logout clears the cookie; rotating the
  client secret invalidates every session at once.
- Honest trade-off: the payload is integrity-protected, **not encrypted** —
  the session carries a platform-audience access token readable by the
  browser's owner (httpOnly keeps it from JS). Acceptable for first-party
  confidential-client sessions; if that ever isn't, swap `seal`/`open` for
  AES-GCM in one place.

### Credential precedence in `requireAuth` (Option B′ intact)

1. `Authorization: Bearer` — verified against JWKS with
   `aud ∈ [<app>.<domain>, https://mcp.<domain>]`. This is how the meta-MCP
   and CLI call the app — **unchanged**.
2. `terrarium_session` cookie — opened, expiry-checked, and its embedded
   access token verified exactly like a bearer.

No valid credential: API/fetch requests get **401 + WWW-Authenticate** (the
SPA's client turns that into a bounce to `/auth/login`); requests with
`Accept: text/html` on worker-first routes get **302 → /auth/login**.

### The no-logged-out-state guarantee

- **Page loads**: `GET /` is served by the Cloudflare asset layer and never
  runs the Worker, so the redirect lives client-side by construction: the
  root route's `beforeLoad` calls `GET /auth/me`; a 401 sets
  `window.location = "/auth/login"` which 302s to Logto. There is no login
  button and no logged-out copy — only a loading state.
- **API surfaces**: 401 + `WWW-Authenticate` (fetch semantics); HTML
  requests 302 (browser semantics).
- **After login** the callback 302s to `/` and the SPA comes up authed.

### Audience model

Per docs/identity.md + Option B′: the app requests its session tokens with
the **platform resource** (`resource=https://mcp.vibevarium.com`, RFC 8707 —
repeated at the token exchange so the access token is a JWT), and accepts
`aud ∈ [own, platform]`. One platform token therefore opens every app
(meta-MCP/CLI), and the SPA's session token is that same shape.

### Env contract (worker env, from the deployer / scaffold)

| Var | Purpose |
| --- | --- |
| `TERRARIUM_ISSUER` | OIDC issuer; unset ⇒ auth off (local dev default) |
| `TERRARIUM_AUDIENCE` | App's own audience (`<name>.<domain>`) |
| `TERRARIUM_PLATFORM_AUDIENCE` | Platform resource (`https://mcp.<domain>`); also the session token's RFC 8707 resource |
| `TERRARIUM_CLIENT_ID` | Per-app Logto Traditional-web client id |
| `TERRARIUM_CLIENT_SECRET` | Its secret — **worker secret, never in source** |
| `TERRARIUM_APP_ORIGIN` | (optional) pin the redirect_uri origin; defaults to the request's own origin (`originalUrl` + `x-forwarded-proto`) |

## Scaffold follow-up: auto-register per-app OIDC clients (owner: scaffold)

Today the two live apps were registered by hand (below). The scaffold
(`packages/control-plane/src/scaffold/…`) must do this at app deploy time —
a generated app is broken without it (SPA can never log in):

1. **Create** the client when an app is first deployed, using the control
   plane's Logto Management API M2M creds (LOGTO_APP_ID/LOGTO_APP_SECRET —
   the `control-plane-m2m` app, secret in SM at the same path as the GUI
   secret):

   ```text
   POST https://auth.vibevarium.com/oidc/token
     grant_type=client_credentials&client_id=$LOGTO_APP_ID
     &client_secret=$LOGTO_APP_SECRET
     &resource=https://default.logto.app/api&scope=all
     → management API access token

   POST https://auth.vibevarium.com/api/applications
     Authorization: Bearer <mgmt token>
     {"name":"Terrarium App: <name>","type":"Traditional",
      "oidcClientMetadata":{
        "redirectUris":["https://<name>.<domain>/auth/callback"],
        "postLogoutRedirectUris":["https://<name>.<domain>/"]}}
     → { "id": "<client-id>" }          (NOTE: no secret in the response)

   GET https://auth.vibevarium.com/api/applications/<client-id>/secrets
     Authorization: Bearer <mgmt token>
     → [{ "name": "Default secret", "value": "<client-secret>", … }]
   ```

   Reference registrations made this way on 2026-11-23 (still live):

   | app | client id | redirect URIs |
   | --- | --- | --- |
   | tickets | `wpm14ynccwetwvnvxs368` | `https://tickets.vibevarium.com/auth/callback` |
   | notes | `s4fryd1spixiyz8ncqm35` | `https://notes.vibevarium.com/auth/callback` |

   (A `GET /api/applications` showed only GUI/CLI/discovery/control-plane-m2m
   registrations before this — apps had no clients of their own.)

2. **Store** the pair into the app's worker env through the deployer:
   `TERRARIUM_CLIENT_ID` as plain env, `TERRARIUM_CLIENT_SECRET` as a worker
   secret. The template's `TicketsWorker.ts` already forwards both from
   `process.env` into the worker `env` (plain entries, matching how the
   deployer's `alchemy deploy` env passing works today — upgrade the
   secret one to a real CF secret binding when the deployer grows that).

   Reference deploy commands used for the live apps (from
   `packages/template-cloudflare`, repo-root `.env` sourced):

   ```sh
   WORKER_NAME=tickets D1_DATABASE_NAME=tickets-data \
   APP_HOSTNAME=tickets.vibevarium.com STACK_NAME=TerrariumAppTickets \
   TERRARIUM_ISSUER=https://auth.vibevarium.com/oidc \
   TERRARIUM_AUDIENCE=tickets.vibevarium.com \
   TERRARIUM_PLATFORM_AUDIENCE=https://mcp.vibevarium.com \
   TERRARIUM_CLIENT_ID=wpm14ynccwetwvnvxs368 TERRARIUM_CLIENT_SECRET=<secret> \
   pnpm exec alchemy deploy --yes --adopt
   # same for notes with the notes id/secret
   ```

   The deployer should persist the client id in its app record so redeploys
   reuse (not recreate) the client.

3. **Delete** the client on app teardown:
   `DELETE https://auth.vibevarium.com/api/applications/<client-id>` with the
   mgmt token. (Not exercised in this spike — no app was torn down.)

4. Keep the template side untouched: it reads only `TERRARIUM_CLIENT_ID` /
   `TERRARIUM_CLIENT_SECRET`, so the scaffold contract above slots in with
   zero template changes.

## Live proof (2026-11-23, tickets + notes on vibevarium.com)

Unauthenticated behavior:

```text
GET /auth/login                 → 302 https://auth.vibevarium.com/oidc/auth
                                  ?client_id=wpm14ynccwetwvnvxs368
                                  &redirect_uri=https://tickets.vibevarium.com/auth/callback
                                  &resource=https://mcp.vibevarium.com
                                  &code_challenge=…&code_challenge_method=S256&state=…
                                  + Set-Cookie: terrarium_login=…; HttpOnly; Secure
GET /TicketList/all  (no auth)  → 401, WWW-Authenticate: Bearer error="invalid_token"
GET /TicketList/all  (Accept: text/html) → 302 /auth/login
GET /mcp             (no auth)  → 401
GET /auth/me         (no cookie)→ 401
```

Full scripted login (Logto Experience API as testUser, the proven scripted
path — same driver as `packages/control-plane/scripts/logto-auth-demo.ts`):

```text
/auth/callback?code&state       → 302 /, Set-Cookie: terrarium_session=…; HttpOnly; SameSite=Lax; Secure
GET /auth/me (session cookie)   → 200 {"actor":{"sub":"egu6d81sqny6","name":"testUser"},"auth":"on"}
GET /TicketList/all (cookie)    → 200 {"tickets":[…]}
POST /OpenTicket (cookie)       → 200 {"reply":null,"stream":"Ticket/ce96724b-…","version":1}
GET /whoami (cookie)            → 200 {"actor":{"sub":"egu6d81sqny6","name":"testUser"},"auth":"on"}
GET /auth/logout                → 302 https://auth.vibevarium.com/oidc/session/end?post_logout_redirect_uri=…
GET /auth/me after logout       → 401
```

Option B′ bearer path, unchanged: the session's embedded access token
(`aud="https://mcp.vibevarium.com"`, `iss=https://auth.vibevarium.com/oidc`)
replayed as `Authorization: Bearer` → `/TicketList/all` 200 and `/mcp`
passes auth (400 only for a missing MCP-Protocol-Version header — protocol,
not auth). Identical results on `notes.vibevarium.com`.

## Open questions / follow-ups

- The `runWorkerFirst` list duplicates the surface paths by hand. Domain's
  `toHttpApi` knows its own routes; a future helper could derive the
  worker-first globs from the Api declaration. (Note the parallel with the
  frontend's vendored `api/TicketsApi.ts` — both hand-mirror the Api surface;
  the same helper could generate the vendored client declaration too.)
- First `atLeast` read on a cold view DO is slow (observed ~30s once,
  sub-second thereafter). Worth a Domain-side look at view wake-up.
- `web/` is excluded from the root `tsrs -b` (own tsconfig, vite checks at
  build). If templates should typecheck the SPA in CI, add
  `web/tsconfig.json` to the scaffold's typecheck step.
- ~~When Logto is live: replace `devLogin`~~ — done (see "The real login
  flow"). The dev-issuer button is gone; auth-off local dev needs no login.
- Sessions are not refreshable: when the access token expires the SPA
  bounces through `/auth/login` again (SSO makes it a silent round-trip).
  If that becomes visible, add refresh-token use to `/auth/me` — the
  callback already requests `offline_access`.
- `TERRARIUM_CLIENT_SECRET` currently travels as a plain worker env var via
  the deployer's env passing; promote to a real CF secret binding when the
  deployer grows secret support (scaffold follow-up #2).
