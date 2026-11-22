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
│   ├── src/App.tsx         # tickets UI: list / open / close, session panel
│   ├── src/client.ts       # tiny typed fetch client + bearer-token handling
│   └── vite.config.ts      # dev proxy: API paths → localhost:1337 (alchemy dev)
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
  discovery), and the assets themselves.
- **Frontend flow:** token lives in memory + sessionStorage, attached as
  `Authorization: Bearer` by `web/src/client.ts`. "Login (dev)" fetches a
  token from the dev-issuer's `/dev/token` endpoint using the issuer the
  Worker reports in `/auth/status`. When Logto is live, that one function
  becomes a hosted-page redirect (authorization code + PKCE); everything
  downstream — token storage, bearer attachment, `/whoami` — is unchanged.

Proven locally (the deployed Worker cannot reach a localhost dev-issuer —
auth-on deploys need a reachable issuer):

```text
GET  /auth/status                     → {"enabled":true,"issuer":"http://127.0.0.1:4010"}
GET  /whoami          (no token)      → 401, WWW-Authenticate: Bearer error="invalid_token"
GET  /whoami          (dev token)     → {"actor":{"sub":"user-ada","name":"Ada"},"auth":"on"}
GET  /TicketList/all  (no token)      → 401
POST /OpenTicket      (dev token)     → {"reply":null,"stream":"Ticket/auth-1","version":1}
```

Same flow through the vite proxy (:5173) works, so the UI's Login (dev)
button exercises it end to end.

## Open questions / follow-ups

- The `runWorkerFirst` list duplicates the surface paths by hand. Domain's
  `toHttpApi` knows its own routes; a future helper could derive the
  worker-first globs from the Api declaration.
- First `atLeast` read on a cold view DO is slow (observed ~30s once,
  sub-second thereafter). Worth a Domain-side look at view wake-up.
- `web/` is excluded from the root `tsrs -b` (own tsconfig, vite checks at
  build). If templates should typecheck the SPA in CI, add
  `web/tsconfig.json` to the scaffold's typecheck step.
- When Logto is live: replace `devLogin` in `web/src/client.ts` with the
  hosted-page redirect + PKCE callback route (a `/auth/callback` client
  route — the SPA fallback already serves it).
