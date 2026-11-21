# Real scaffold, GitHub App, Cloudflare Domain, and gitprops.com spike

## Verdict

The real path works. `POST /scaffold {name}` creates a private GitHub repository containing a self-contained deployable app, provisions D1 and an Effect-native Cloudflare Worker with `DomainCloudflare.layerDurableObjects()`, discovers its four MCP tools, and attaches `https://<name>.gitprops.com` to that Worker. A command and read round-trip through that public hostname reaches the app's real Durable Objects. `DELETE /apps/:name` removes the Worker, D1 database, GitHub repository, registry entry, router KV entry, and per-app service binding.

The sample app is intentionally unauthenticated for this spike. No auth server or OIDC client registration is involved.

## Phase 1: real Domain on Cloudflare

The new `packages/template-cloudflare` package follows `examples/cloudflare-domain` and `hosting.md`: an Effect-native `Cloudflare.Worker`, `TicketsModel.layer(...)` provided with `DomainCloudflare.layerDurableObjects()`, D1 declared and bound via `Cloudflare.D1.QueryDatabaseBinding`, and both `Cloudflare.providers()` and `DomainCloudflare.providers()` on the stack.

Initial proof:

- Worker: `https://terrarium-tickets-cloudflare.modal-opencode-test.workers.dev`
- D1: `terrarium-tickets-cloudflare-data` / `e21eddcf-636b-431e-a8a7-3b8e138d8ef8`

```json
{"d1":"bound","rows":[{"value":"tickets-d1"}]}
{"reply":null,"stream":"Ticket/phase1-real-1","version":1}
{"id":"phase1-real-1","title":"Real Durable Object round trip","reporter":"phase1-demo","status":"open"}
```

The read passed `?stream=Ticket%2Fphase1-real-1&version=1`, proving read-your-write consistency rather than an in-memory response. D1 runs the migration in `migrations/0001_app_metadata.sql`; the canonical ticket list remains a Domain view in a Durable Object.

## Phase 2: GitHub App

`src/scaffold/github-app-provider.ts` implements the existing `GitProvider` interface with Octokit App JWT + installation token handling. `GIT_PROVIDER=github|local` chooses it; the local provider remains intact.

An empty GitHub repository rejects Git Data blob creation with `409 Git Repository is empty`. The provider bootstraps a Contents ref, creates all blobs/tree/root commit, then force-updates `main` to the intended single initial commit.

```text
Repository: https://github.com/terrarium-sandbox/terrarium-git-proof-76434
Verified 1 commit: f5edc5292b07651bd603f9844d51af2170050fa0 Initial scaffold
Worker source committed: true
Cleanup: deleted
```

## Phase 3: real scaffold

`src/scaffold/template.ts` materializes the entire self-contained Worker source (18 files in the proof), parameterizes package/Worker/D1/stack names, and writes a standalone tsconfig. No `workspace:*` wrapper is committed.

`src/scaffold/cloudflare-deployer.ts` shells out to the Alchemy CLI in the generated directory. For this local control-plane spike it links the installed template's ignored `node_modules`; the generated repo itself is standalone and has a normal `pnpm install`/`pnpm run deploy` path. A fresh deploy can take 30–60s because Domain declares backfill resources. Backfill's `InstanceNotFound` on immediate Workflow status reads is retried up to three times.

`POST /scaffold` returns repo URL, Worker URL, hostname, deployment metadata, and the registry/directory entry with four tools. Discovery uses stateless MCP `2026-07-28` for Worker-hosted children; the existing sessionful `2025-11-25` remains for localhost children.

## Phase 4: hostname and router

`src/router` is a small real Cloudflare stack with KV (`terrarium-router-apps`, id `7953882922294f5b84298ba7d8794fe4`) and routes. `gitprops.com/*` is deployed. The wildcard `*.gitprops.com/*` route was successfully created, not plan-gated, but wildcard DNS cannot be created with this OAuth grant: `GET /zones/15d5d22954d28f66f4e141a1668df477/dns_records` returns 403 with code `10000 Authentication error`. `dns_records.list` and `dns_records.create` therefore fail, so wildcard routing was disabled after proving route creation.

The useful fallback is **native per-app Worker custom domains**, not per-app routes. Alchemy's `Cloudflare.Worker({ domain: { name, zoneId } })` creates DNS and a certificate through the Workers API, which this grant can use. The probe and the real `expenses.gitprops.com` both returned enabled attachments with certificate IDs. Public recursive DNS resolves the hostname. This is now the primary scaffold path and avoids the wildcard DNS scope entirely.

For router proxying, public Worker-to-Worker `fetch("https://<app>.workers.dev")` returned Cloudflare's generic 404 despite direct external access succeeding. Native service bindings (`Worker.lookup` + `env.APP_<name>` + `fetcher.fetch(request)`) worked. Scaffold adds/removes those bindings in `AppWorkers` and stores the selected worker name in KV. The router has no callback to the localhost control plane. The wildcard router can be restored once wildcard DNS exists; per-app custom domains are used for the final literal hostname proof.

## Phase 5: real demo output

The `scripts/real-deploy-demo.ts` proof created, verified, and deleted `expenses`:

```json
{
  "repoUrl": "https://github.com/terrarium-sandbox/expenses",
  "workerUrl": "https://expenses.modal-opencode-test.workers.dev",
  "hostname": "expenses.gitprops.com",
  "discoveredTools": 4
}
GitHub: 1 commit(s), 70f40b519c4858034d4be7488e9483d4b6b4d7b8, Initial scaffold; src/TicketsWorker.ts exists
Router registry: {"apps":["expenses"]}
Router command: {"reply":null,"stream":"Ticket/router-expenses-1","version":1}
Router read: {"id":"router-expenses-1","title":"Command through the real Terrarium router","reporter":"real-deploy-demo","status":"open"}
{"name":"expenses","deleted":true,"workerDeleted":true,"d1Deleted":true,"repoDeleted":true}
{
  "repo": "deleted",
  "worker": {
    "status": 404,
    "body": [{"code":10007,"message":"This Worker does not exist on your account."}]
  },
  "d1ContainsApp": false
}
```

The literal public custom domain was then exercised (IPv4 selected explicitly while the local stub resolver had a stale negative cache):

```json
{"reply":null,"stream":"Ticket/public-router-expenses-1","version":1}
{"id":"public-router-expenses-1","title":"Public custom-domain command","reporter":"real-deploy-demo","status":"open"}
```

`curl https://expenses.gitprops.com/health` returned `ok` over HTTPS. The app was subsequently deleted again as part of cleanup.

## Configuration

The control plane accepts the existing local settings plus:

| Variable | Meaning |
| --- | --- |
| `GIT_PROVIDER` | `github` for real mode; otherwise local |
| `GITHUB_APP_INSTALLATION_ID` | installation id for `GITHUB_ORG` |
| `GITHUB_ORG` | GitHub organization (`terrarium-sandbox` for the proof) |
| `CLOUDFLARE_ACCOUNT_ID` | real account id |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | account's workers.dev subdomain |
| `CLOUDFLARE_ZONE_ID` | `gitprops.com` zone id |
| `ROUTER_KV_NAMESPACE_ID` | router directory namespace |
| `ALCHEMY_HOME` | isolated Alchemy profile root; keep it gitignored |

Secrets come from `.env` / `.secrets/` or `CLOUDFLARE_API_TOKEN`; none are committed. `.alchemy-home/`, `.alchemy/`, and `.data/` are ignored. Alchemy beta.87 did not automatically read Wrangler OAuth. A project-local profile was imported; refresh initially returned `invalid_grant ... issued to another client`. Refreshing with Wrangler's public client id `54d11594-84e4-41aa-b438-e81b8fa78ee7` worked. A normal scoped API token remains the simpler production choice.

## Findings that diverged from the localhost spikes

- **Real Domain hosting works** — no in-memory fallback was needed. Register both provider layers or backfill has no provider.
- **MCP is stateless on Workers** — `layerHttpRequestScoped` supports `2026-07-28`, not the localhost sessionful protocol.
- **Backfill needs a retry around instance reads** — `workflows.api.error.instance.not_found` can appear immediately after the Worker upload and can recur on the first retry. `Backfill.ts` retries internal errors but not this tag; the control plane retries the deploy up to three times.
- **Worker.lookup cannot resolve deleted workers** — remove service bindings before deleting the app Worker, re-reading router source each time. Old cached source caused repeat-delete failures before this fix.
- **Custom domains are not routes** — a wildcard router route captures a custom-domain request before the app's own Worker. Don't run the wildcard route while relying on direct per-app custom domains.
- **Native custom domains avoid the DNS scope gap** — wildcard DNS needs a DNS:Edit token, but native per-app domains already work through the Workers grant. Wildcard routing can be re-enabled later.
- **Service bindings beat workers.dev fetch proxying** — plain Worker-to-worker workers.dev fetches got edge 404s; service bindings succeeded.
- **Programmatic Alchemy needs full Node services** — its Cloudflare credential layer is CLI-context-rich; the control-plane KV writer instead uses the authenticated profile/API token and checked plain REST calls.
- **GitHub empty repos need a bootstrap ref** before Git Data operations.
- **Generated app repositories are real forks**, not wrappers. The local dependency symlink is only a deploy optimization and never committed.

## Re-run

```sh
# from the repository root, after pnpm install and loading .env
GIT_PROVIDER=github GITHUB_APP_INSTALLATION_ID=184285119 \
GITHUB_ORG=terrarium-sandbox \
CLOUDFLARE_ACCOUNT_ID=7bbaa8f97d6ababf1a5e29eb79491ce3 \
CLOUDFLARE_WORKERS_SUBDOMAIN=modal-opencode-test \
CLOUDFLARE_ZONE_ID=15d5d22954d28f66f4e141a1668df477 \
ROUTER_KV_NAMESPACE_ID=7953882922294f5b84298ba7d8794fe4 \
ALCHEMY_HOME=$PWD/.alchemy-home DISCOVERY_INTERVAL_MS=0 \
DISCOVERY_TIMEOUT_MS=20000 CALL_TIMEOUT_MS=20000 \
DATABASE_PATH=.data/real-control-plane PORT=4143 \
pnpm --filter @terrarium/control-plane start

# in another shell
pnpm --filter @terrarium/control-plane real:demo
# retain the app instead of deleting it:
SKIP_DELETE=1 pnpm --filter @terrarium/control-plane real:demo
```

Validation: `tsrs --noEmit` is clean for control-plane, template-cloudflare, and router. `oxlint --type-aware` reports only `_tag` naming and demo/type-narrowing warnings.
