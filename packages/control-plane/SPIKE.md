# Meta-MCP gateway spike

> See [SCAFFOLD-SPIKE.md](./SCAFFOLD-SPIKE.md) for generated apps, optional template OIDC auth, authenticated discovery, and the end-to-end authenticated gateway proof.
> See [GUI-SPIKE.md](./GUI-SPIKE.md) for the React control-plane GUI and local dev orchestrator, and [PROXY-SPIKE.md](./PROXY-SPIKE.md) for the integration proxy (grants, env-var secrets, audit).

## Verdict

The hard part works locally. Two independently hosted ticket apps are aggregated behind one Effect MCP streamable-HTTP endpoint. Discovery is asynchronous and stored in PGlite; `tools/list` never calls a child. Calls are routed to a fresh scoped `McpClient` for the selected child, with caller headers and complete tool results passed through. Closing app B does not remove its last-known directory entries, does not hang the gateway, and does not affect subsequent calls to app A.

This is deliberately throwaway-friendly: no auth verification, migrations framework, connection pool, circuit breaker, prompts/resources, or production hardening.

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter @terrarium/control-plane demo
pnpm --filter @terrarium/control-plane test
pnpm exec tsrs --noEmit -p packages/control-plane/tsconfig.json
pnpm exec oxlint --type-aware packages/control-plane
```

The demo boots two real `@terrarium/template` servers on ephemeral ports, boots the gateway and an embedded PGlite database, performs the complete proof, asserts it, and prints the full report (including every unabridged tool JSON Schema). TypeScript execution uses `node --experimental-strip-types`, matching the template.

To run a persistent control plane:

```sh
PORT=4100 pnpm --filter @terrarium/control-plane start
# Optional: durable rather than in-memory PGlite storage
DATABASE_PATH=.data/control-plane pnpm --filter @terrarium/control-plane start
```

Configuration environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PORT` | `4100` | HTTP port (`0` is supported programmatically for an ephemeral port) |
| `DATABASE_PATH` | unset | PGlite data directory; unset means in-memory |
| `DISCOVERY_INTERVAL_MS` | `30000` | Scheduled discovery interval; `0` disables the schedule |
| `DISCOVERY_TIMEOUT_MS` | `3000` | Per-app discovery/connect/list deadline |
| `CALL_TIMEOUT_MS` | `3000` | Per-app connect/call deadline |
| `CONTROL_PLANE_ISSUER` | unset | OIDC issuer for the control plane's own HTTP surfaces; unset means dev-open |
| `CONTROL_PLANE_AUDIENCE` | `control.terrarium.local` | Audience expected on control-plane tokens |
| `APP_SECRETS` | unset | JSON object of pre-M2M app credentials for the integration proxy (or `APP_SECRET_<NAME>` env vars) |
| `GUI_DIR` | `web/dist` | Built GUI directory served at `/`; missing dir disables the mount |
| `INTEGRATION_<NAME>_TOKEN` | unset | v1 integration tokens (referenced by `token_env` rows; see PROXY-SPIKE.md) |

Operational endpoints (bearer-gated when `CONTROL_PLANE_ISSUER` is set):

```sh
curl -X POST http://127.0.0.1:4100/apps \
  -H 'content-type: application/json' \
  -d '{"name":"tickets-a","url":"http://127.0.0.1:3000/mcp"}'
curl http://127.0.0.1:4100/apps
curl -X POST http://127.0.0.1:4100/discover
curl http://127.0.0.1:4100/directory
curl http://127.0.0.1:4100/whoami
curl http://127.0.0.1:4100/health
```

The aggregated MCP endpoint is `POST /mcp`, protocol `2025-11-25`.

## What was built

- `src/store/`: Drizzle schema and a scoped PGlite connection. Startup uses idempotent DDL; no server or Docker is needed.
- `src/registry/`: an Effect `Registry` service with register/upsert, list, get, remove, and up/down status updates.
- `src/discovery/`: an Effect `Directory` store plus a `Discovery` service. Registered apps are discovered concurrently, each with an isolated scoped `McpClient` and timeout. Success replaces that app's rows in one transaction. Failure only marks that app down and its existing rows stale.
- `src/gateway/`: low-level dynamic `McpServer.addTool` registrations, directory tools, namespacing, visibility, and the per-call `AppProxy`.
- `src/server.ts` / `src/main.ts`: registry/discovery/gateway composition, scheduled and on-demand discovery, HTTP operations, and the Node entrypoint.
- `src/proof.ts`, `src/proof.test.ts`, `scripts/demo.ts`: the same real two-app proof in Vitest and executable demo forms.

App names are lower-kebab-case. Therefore the first underscore in `{appName}_{toolName}` is an unambiguous separator; underscores in the remote tool name are preserved. A directory row is checked again at call time so a name cannot be routed to a different app.

## Directory schema

```sql
CREATE TABLE registry_apps (
  name text PRIMARY KEY,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'unknown', -- unknown | up | down
  last_seen_at timestamptz,              -- last successful discovery
  last_checked_at timestamptz,           -- latest discovery attempt
  last_error text
);

CREATE TABLE directory_tools (
  app_name text NOT NULL REFERENCES registry_apps(name) ON DELETE CASCADE,
  remote_name text NOT NULL,              -- original child tool name
  gateway_name text NOT NULL UNIQUE,      -- appName_remoteName
  descriptor jsonb NOT NULL,              -- complete remote MCP Tool descriptor
  discovered_at timestamptz NOT NULL,
  stale boolean NOT NULL DEFAULT false,
  PRIMARY KEY (app_name, remote_name)
);
```

`descriptor` retains the remote description, input/output JSON Schemas, annotations, icons, and `_meta`. The gateway changes the exposed name and adds this metadata:

```json
{
  "terrarium/app": "tickets-a",
  "terrarium/stale": false
}
```

### Why `tools/list` does not fan out

There are two pieces to the current spike implementation:

1. On boot and after each discovery run, `syncGatewayTools` reads directory rows and registers/updates their descriptors with `McpServer.addTool`. No child connection is made by this synchronization.
2. Effect MCP has no `removeTool`. A global `McpServer.visibility` checks the current directory row for each registered name on list and call. Removed rows disappear even though their historical registrations remain in memory.

Consequently, `tools/list` performs no remote requests and current PGlite rows are authoritative. The historical in-memory registration union can grow until restart; that is an accepted spike limitation, not a desired final design.

A failed discovery does not replace or delete rows. It sets `registry_apps.status = 'down'` and `directory_tools.stale = true`, retains `last_seen_at`, and records the error/check time. Calls still attempt the child even when marked down, allowing recovery before the next scheduled refresh.

## Calling and headers

For each proxied call the gateway:

1. Parses and validates the namespaced name against the stored row.
2. Reads the caller's `HttpServerRequest` with `Effect.serviceOption`.
3. Builds a scoped `McpClient` for the row's app and calls the original remote tool name.
4. Supplies the inbound headers to `McpClient.layerHttp({ headers })`, excluding hop-by-hop headers and all inbound `mcp-*` transport state. `Authorization`, cookies, tracing, and custom `x-*` headers pass through. The child gets its own MCP protocol/session headers.
5. Applies both the client's call deadline and an outer per-app deadline. Remote `CallToolResult` values, including `structuredContent` and child-reported `isError`, pass through intact.
6. Converts transport/discovery failures into a fast tool error result rather than a failed gateway request:

```json
{
  "isError": true,
  "structuredContent": {
    "error": {
      "_tag": "AppUnavailable | AppTimeout | ToolNotFound | AppNotRegistered",
      "app": "tickets-b",
      "tool": "tickets-b_TicketsApi_OpenTicket_send",
      "message": "...",
      "cause": { "_tag": "TransportError", "message": "..." }
    }
  }
}
```

The template has no header-echo tool. The proof therefore wraps the real `FetchHttpClient.Fetch` used by the gateway's child `McpClient` and records the actual outbound request before native `fetch` sends it. This demonstrates forwarding at the Effect MCP transport level without modifying the template; it is not represented as an application-level echo assertion.

## What Effect MCP is good/bad at for this proxy

### Good

- `McpClient.layerHttp` handles initialization, legacy MCP sessions, session cleanup, JSON/SSE responses, descriptor decoding, and typed transport/protocol errors.
- `listTools({ timeout })` and `callTool(..., { timeout })` provide useful deadlines. The proxy adds an outer deadline around connection setup as well.
- `callTool` without a success `Schema` returns the complete `CallToolResult`, which is exactly what a passthrough proxy needs.
- Low-level `McpServer.addTool` accepts runtime `McpSchema.Tool` descriptors and raw JSON Schemas. There is no need to turn a remote tool into a statically typed Effect `Tool`.
- `McpServer.visibility` provides a workable removal/filtering seam, and request HTTP headers are available through `HttpServerRequest`.
- `McpClient.layerHttp({ headers })` is a straightforward auth-header insertion point. Creating the client per inbound call avoids putting different callers' credentials on one shared client.

### Bad or awkward

- **Dynamic registration is not a dynamic list callback.** `addTool` replaces a same-named registration but has no removal API. The visibility workaround still retains historical registrations and performs a directory lookup per name. Rebuilding an isolated server from a snapshot, or a first-class dynamic registry/removal API, would be cleaner.
- **`layerHttpRequestScoped` does not solve this by itself.** Its registrations are built once and shared by POSTs; it is about request-owned execution, not rebuilding the tool set from a store for every list request.
- **Schema-class values need care.** Object-spreading `McpSchema.Tool` loses its class prototype. More surprisingly, embedding `McpSchema.Tool` instances inside another tool's `structuredContent` produced a generic MCP internal error in this spike. `src/tool-descriptor.ts` explicitly copies wire fields; registration uses `new McpSchema.Tool(...)`, while nested result payloads use plain objects.
- **Raw JSON Schema is not an Effect argument decoder.** The gateway validates that proxy arguments are an object and lets the child validate the tool-specific contract. The directory search tool decodes its own `{ query }` input explicitly. A production gateway should decide whether to add full JSON Schema validation or consistently delegate it.
- **Header passthrough is not automatic across two MCP hops.** The client header option is fixed at client construction, hence the fresh client per call. Inbound MCP session/protocol headers must not leak into the child connection.
- **Per-call clients are simple but expensive.** Every proxied call performs initialization and session teardown. Pooling needs a principal-aware design; pooling only by app would risk reusing a client configured with another caller's headers.
- **Timeout and cleanup are separate concerns.** Effect's legacy HTTP transport also has session-DELETE cleanup behavior. A hung cleanup deserves a separate production test; the spike proves connection-refused failure and bounded calls, not every possible network stall.
- **Fidelity is bounded by Effect's MCP model.** Standard input/output schemas, descriptions, annotations, and results passed through in the proof. `McpClient` validates descriptors and can omit unsupported/non-callable tool variants, so this is not a byte-for-byte arbitrary JSON-RPC proxy. Prompt/resource forwarding and child reverse requests are not implemented.

## Real proof output

The following are excerpts from the successful final demo. The command prints the complete, unabridged report. Ports and timestamps naturally vary.

### Discovery and gateway `tools/list`

Both real apps initially returned four tools:

```json
[
  { "name": "tickets-a", "status": "up", "toolCount": 4 },
  { "name": "tickets-b", "status": "up", "toolCount": 4 }
]
```

The gateway result contained these ten tools (name projection of the actual `result.tools` array):

```json
{
  "tools": [
    { "name": "directory_list_apps" },
    { "name": "directory_search_tools" },
    { "name": "tickets-a_TicketsApi_CloseTicket_send" },
    { "name": "tickets-a_TicketsApi_OpenTicket_send" },
    { "name": "tickets-a_TicketsApi_TicketById_get" },
    { "name": "tickets-a_TicketsApi_TicketList_get" },
    { "name": "tickets-b_TicketsApi_CloseTicket_send" },
    { "name": "tickets-b_TicketsApi_OpenTicket_send" },
    { "name": "tickets-b_TicketsApi_TicketById_get" },
    { "name": "tickets-b_TicketsApi_TicketList_get" }
  ]
}
```

One complete descriptor from that same array shows schema and annotation passthrough (the view schemas are much larger and are printed by the demo):

```json
{
  "name": "tickets-a_TicketsApi_OpenTicket_send",
  "description": "Open a support ticket, generating its id when --target is omitted.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "input": {
        "type": "object",
        "required": ["title", "reporter"],
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1,
            "description": "A short summary of the problem."
          },
          "reporter": {
            "type": "string",
            "minLength": 1,
            "description": "The person reporting the problem."
          }
        },
        "additionalProperties": true
      },
      "target": { "type": "string", "description": "The unique ticket id." },
      "commandId": {
        "anyOf": [{ "type": "string" }, { "type": "null" }]
      }
    },
    "required": ["input"],
    "additionalProperties": true
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "reply": { "type": "null" },
      "stream": { "type": "string" },
      "version": {
        "anyOf": [
          { "type": "number" },
          { "enum": ["Infinity", "-Infinity", "NaN"], "type": "string" }
        ]
      }
    },
    "required": ["reply", "stream", "version"],
    "additionalProperties": true
  },
  "annotations": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "_meta": { "terrarium/app": "tickets-a", "terrarium/stale": false }
}
```

The proof deep-equals both input and output schemas and annotations against the discovered remote descriptor. `directory_search_tools({ "query": "open a support ticket" })` returned both namespaced open-ticket tools, and `directory_list_apps` returned both registry rows.

### A call really reached app A

Gateway `tools/call tickets-a_TicketsApi_OpenTicket_send` returned:

```json
{
  "content": [
    { "type": "text", "text": "{\"reply\":null,\"stream\":\"Ticket/proof-a-1\",\"version\":1}" }
  ],
  "structuredContent": { "reply": null, "stream": "Ticket/proof-a-1", "version": 1 },
  "isError": false
}
```

A direct HTTP read from app A, not the gateway, confirmed the state:

```json
{
  "id": "proof-a-1",
  "title": "Created through meta-MCP in app A",
  "reporter": "gateway-proof",
  "status": "open"
}
```

The real child transport ledger recorded the stripped remote tool name and both caller headers:

```json
{
  "url": "http://127.0.0.1:36149/mcp",
  "method": "POST",
  "headers": {
    "authorization": "Bearer proof-token",
    "x-spike-marker": "proof-from-agent",
    "mcp-protocol-version": "2025-11-25"
  },
  "body": {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "TicketsApi_OpenTicket_send",
      "arguments": {
        "target": "proof-a-1",
        "input": {
          "title": "Created through meta-MCP in app A",
          "reporter": "gateway-proof"
        }
      }
    }
  }
}
```

### Kill app B sequence

The same gateway MCP client stayed connected while app B's server scope was closed. Re-running discovery produced:

```json
[
  { "name": "tickets-a", "status": "up", "toolCount": 4 },
  {
    "name": "tickets-b",
    "status": "down",
    "error": { "_tag": "TransportError", "message": "MCP HTTP request failed" },
    "retainedToolCount": 4
  }
]
```

B's registry row retained its last successful timestamp:

```json
{
  "name": "tickets-b",
  "status": "down",
  "lastSeenAt": "2026-11-21 01:19:58.27+00",
  "lastCheckedAt": "2026-11-21 01:19:58.329+00",
  "lastError": "TransportError: MCP HTTP request failed"
}
```

All four B tools remained in both the directory and gateway `tools/list`, with `stale: true` in the rows and `terrarium/stale: true` in the exposed descriptors:

```json
[
  "tickets-b_TicketsApi_CloseTicket_send",
  "tickets-b_TicketsApi_OpenTicket_send",
  "tickets-b_TicketsApi_TicketById_get",
  "tickets-b_TicketsApi_TicketList_get"
]
```

Calling B failed in **5 ms** in this run:

```json
{
  "structuredContent": {
    "error": {
      "_tag": "AppUnavailable",
      "app": "tickets-b",
      "tool": "tickets-b_TicketsApi_OpenTicket_send",
      "message": "Could not call tickets-b: MCP HTTP request failed",
      "cause": { "_tag": "TransportError", "message": "MCP HTTP request failed" }
    }
  },
  "isError": true
}
```

Calling A immediately afterwards still worked:

```json
{
  "structuredContent": { "reply": null, "stream": "Ticket/proof-a-2", "version": 1 },
  "isError": false
}
```

And a second direct read from A proved that call also reached the right child:

```json
{
  "id": "proof-a-2",
  "title": "App A still works after app B died",
  "reporter": "gateway-proof",
  "status": "open"
}
```

Vitest result:

```text
✓ src/proof.test.ts (1 test)
✓ meta-MCP gateway aggregates two apps, proxies with headers, and isolates a killed app
Test Files  1 passed (1)
Tests       1 passed (1)
```

## Open questions / likely throwaway boundaries

- Replace the historical-registration/visibility approach with a rebuildable server snapshot or an upstream dynamic registry/removal API; also avoid the current per-name directory lookups on large lists.
- Decide whether child clients can be pooled by `(app, credential/session identity)` without cross-caller credential leakage, and whether session teardown should be on the proxy deadline path.
- Add single-flight/versioned discovery. Manual and scheduled refreshes can currently overlap, and an older response could win a race.
- Add MCP-name length/collision policy and reserve directory-tool names. Lower-kebab app names solve prefix ambiguity only.
- Add a hanging-child test and, if needed, a circuit breaker. The spike implements deadlines, not a breaker.
- Decide how discovery obtains a platform M2M credential, then add `@terrarium/auth` verification around the gateway router. User headers belong on calls, not automatically on scheduled discovery.
- Add real migrations before persistent PGlite schema evolution matters.
- Determine whether prompts/resources, notifications, progress, and child-initiated requests are in scope; this spike only aggregates tools.
- Preserve or intentionally reject MCP tool variants that Effect's descriptor model filters rather than silently treating the gateway as a transparent arbitrary JSON-RPC proxy.

## Blockers

None for the spike. The template's missing header-echo surface was handled inside this package with the real transport ledger as described above. `tsrs` and type-aware `oxlint` both complete cleanly with Effect 4.1.5.
