# Scaffold-flow spike

## Verdict

The control-plane workflow works locally: a name becomes a committed app repo, an independent authenticated Node process, a healthy registry entry, four discovered MCP tools, and a callable meta-MCP tool. A dev-issuer user token reaches the generated app through the gateway unchanged; the app verifies its own `expenses.terrarium.local` audience. A hard control-plane kill leaves the app serving requests.

This is orchestration glue for learning, not a production process supervisor or deployment system.

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter @terrarium/control-plane scaffold:demo
# Existing proofs must still pass:
pnpm --filter @terrarium/control-plane demo
pnpm --filter @terrarium/template demo
pnpm exec tsrs --noEmit -p packages/control-plane/tsconfig.json
pnpm exec tsrs --noEmit -p packages/template/tsconfig.json
```

The scaffold demo boots a real dev OIDC issuer and a separate control-plane process. It uses an isolated `packages/control-plane/.scaffold-demo/run-*/apps/` root so repeated runs do not collide. It prints assertions and their observed results, hard-kills the control plane to prove app independence, then cleans up the generated app process itself. The generated git repo, `app.log`, `app.pid`, and control-plane log are retained for inspection.

For a persistent control plane, the new configuration is:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TERRARIUM_ISSUER` | unset | OIDC issuer injected into generated apps; required only when calling `POST /scaffold` |
| `TERRARIUM_APPS_ROOT` | `<workspace>/apps` | Parent of generated repositories |
| `APP_START_TIMEOUT_MS` | `20000` | Generated-app health deadline |
| `DISCOVERY_TOKEN` | unset | Bearer token used by MCP discovery; required when children require auth |

`POST /scaffold { "name": "expenses" }` returns the app base `url`, per-app `audience`, local `repoUrl`, `processId`, and its registry/directory entry. `DELETE /apps/expenses` stops a tracked child and removes its registry row. Deletion cascades directory rows; the repo directory and logs deliberately remain.

## What the flow does

1. Validates a 1–63 character DNS-label-safe lower-kebab name and rejects a name already in the registry or on disk.
2. Generates `package.json`, `src/main.ts`, `README.md`, and `.gitignore` under `apps/<name>/`.
3. Calls `GitProvider.createRepo(name, files)`. `LocalGitProvider` writes the files, runs `git init`, and creates `Initial scaffold`; `repoUrl` is a `file://` URL.
4. Links the workspace template for module resolution, allocates a localhost port, and spawns the workspace `tsx` CLI in a detached child process. Environment includes `APP_NAME`, `PORT`, `TERRARIUM_AUTH=on`, `TERRARIUM_ISSUER`, and `TERRARIUM_AUDIENCE=<name>.terrarium.local`. Stdout/stderr go to `app.log`.
5. Polls the public `/health` endpoint until ready.
6. Calls the `Registry` service directly with the child's `/mcp` URL.
7. Runs authenticated discovery for the new app and immediately synchronizes gateway tools.
8. Returns the live registration and stored directory rows.

A boot failure stops the child. A discovery failure returns 502 and leaves the running app and down registry row for diagnosis; this spike does not attempt transactional rollback across git, processes, and the registry. Port allocation has the usual allocate-then-release race.

## Wrapper instead of a template fork

The generated repo is deliberately tiny:

```ts
import { runTicketsServer } from "@terrarium/template/server";

runTicketsServer();
```

The wrapper receives all app-specific configuration through env. For the spike, the control plane creates an ignored `node_modules/@terrarium/template` symlink after the initial commit, avoiding a workspace reinstall for every generated app. This proves process, configuration, auth, registry, and discovery orchestration without duplicating template source.

It is **not** the production repository shape. A real scaffold should fork/copy the template into a self-contained repo with a normal lockfile and its own domain declarations. Otherwise every existing app changes whenever the shared workspace template changes. The wrapper was chosen only to keep this spike small and to make the shared-server seam explicit.

## Auth wiring and discovery

The template wraps its final router effect with `@terrarium/auth`'s `requireAuth`, covering the HTTP API, OpenAPI, RPC, and every MCP request. `/health` remains public for orchestration. `GET /whoami` reads `CurrentActor` and echoes it. Generated apps always set `TERRARIUM_AUTH=on` and have a distinct audience.

For backwards compatibility, the standalone template is unauthenticated when no issuer is configured. `TERRARIUM_AUTH=off` explicitly disables auth even if an issuer is present. Setting an issuer enables auth by default; `TERRARIUM_AUTH=on` without an issuer fails startup. The audience defaults to `${APP_NAME ?? "tickets"}.terrarium.local` and can be overridden with `TERRARIUM_AUDIENCE`.

Authenticated children exposed an existing gap: discovery used an unauthenticated `McpClient`, so a protected `/mcp` returned 401 before `initialize`. The spike adds `DISCOVERY_TOKEN` to the control plane and applies it to discovery clients. This is a single static M2M credential, **not** a fleet-wide solution: one token cannot represent arbitrary per-app audiences. Production discovery needs per-app M2M credentials (or another explicit discovery credential policy) stored/resolved by the control plane; scheduled discovery needs the same treatment.

User calls did not need a gateway workaround. The gateway already forwards `Authorization` on its fresh per-call child client. The same dev token used for `/whoami` therefore passed the child OIDC check during MCP initialization and `tools/call`; the audience stayed `expenses.terrarium.local` and no header reshaping was necessary.

## Process lifetime: spike vs production

Children are tracked in the control-plane layer. Graceful control-plane finalization stops all tracked children, and `DELETE` stops one child. They are also detached and unreferenced, so `SIGKILL` cannot run parent cleanup and the child survives—as the demo proves.

That distinction is intentional but not a deployment guarantee. A production control plane should deploy to Workers for Platforms (including env/secrets and a dispatch URL), register the deployed HTTPS MCP endpoint, and never own an app process. The deployment target replaces `AppProcesses`; the rest of the workflow remains orchestration. A production Node supervisor would additionally need restart adoption, orphan reconciliation, signal/escalation handling, and log rotation.

## What a real provider/target swaps in

- **GitHub:** implement `GitProvider.createRepo` using GitHub repo creation and the Contents/Git Data API (or `@alchemy.run/github`), return the HTTPS repo URL, and replace `LocalGitProvider` in the layer. Start from a real template fork rather than the wrapper. Credentials stay in the control plane/provider configuration.
- **Workers:** replace port allocation, workspace linking, `tsx`, health polling of localhost, and `AppProcesses` with the app's Alchemy/Workers-for-Platforms deployment. Inject OIDC config and secrets through the deployment target, wait for the deployed URL, then use the same registry and authenticated discovery stages.
- **Other scaffold stages:** D1 provisioning, real OIDC client registration, and secret injection remain unimplemented here; the dev issuer needs no client registration.

## Open questions / throwaway boundaries

- What is the production per-app discovery credential model, and how is it rotated without exposing user tokens to scheduled jobs?
- How are scaffolds made atomic or compensating across repo creation, deploy, OIDC/D1 provisioning, and registry writes?
- Should the registry persist deployment/repo metadata so a restarted control plane can adopt or clean up existing apps?
- Should name reservation happen in the database before creating external resources to close concurrent-scaffold races?
- Replace process IDs and local filesystem paths in the response with deployment metadata once a real target exists.
- The generated wrapper's workspace symlink and `workspace:*` dependency are local-only conveniences, not publishable package configuration.

## Real proof output

From `pnpm --filter @terrarium/control-plane scaffold:demo` (ports and paths vary; the demo also asserts every status and payload):

```json
{
  "scaffold": {
    "name": "expenses",
    "url": "http://127.0.0.1:46065",
    "audience": "expenses.terrarium.local",
    "processId": 1343180,
    "initialCommit": "Initial scaffold",
    "directoryEntry": {
      "app": { "name": "expenses", "status": "up" },
      "tools": [
        "expenses_TicketsApi_CloseTicket_send",
        "expenses_TicketsApi_OpenTicket_send",
        "expenses_TicketsApi_TicketById_get",
        "expenses_TicketsApi_TicketList_get"
      ]
    }
  },
  "auth": {
    "healthStatus": 200,
    "unauthenticatedWhoAmi": {
      "status": 401,
      "body": {
        "error": "invalid_token",
        "error_description": "Expected an Authorization: Bearer token"
      }
    },
    "unauthenticatedMcpStatus": 401,
    "authenticatedWhoAmi": {
      "status": 200,
      "body": {
        "actor": { "sub": "user-123", "name": "Ada Lovelace" },
        "auth": "on"
      }
    }
  },
  "gateway": {
    "callThrough": {
      "structuredContent": {
        "reply": null,
        "stream": "Ticket/scaffold-demo-1",
        "version": 1
      },
      "isError": false
    },
    "directReadAfterCall": {
      "id": "scaffold-demo-1",
      "title": "Created through the authenticated meta-MCP",
      "reporter": "scaffold-demo",
      "status": "open"
    }
  },
  "independentProcess": {
    "controlPlane": "SIGKILL (no graceful cleanup)",
    "appWhoAmiAfterControlPlaneKill": {
      "status": 200,
      "body": {
        "actor": { "sub": "user-123", "name": "Ada Lovelace" },
        "auth": "on"
      }
    }
  }
}
```
