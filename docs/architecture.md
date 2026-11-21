# Architecture

Two sides: the **child apps** (where `@alchemy.run/domain` does nearly all the
work) and the **gateway** (where domain helps with everything except the dynamic
proxy core).

## Child apps

Each app models its features with `@alchemy.run/domain`: schema'd commands,
queries, views — each declaration carrying a `{ description }` annotation. Then
it declares one Api:

```ts
export class AppApi extends Domain.Api("SupportApi", {
  model: Support,
  commands: ["CreateTicket", "RefundOrder"],
  queries: ["OrderLookup"],
}) {}
```

Every client surface is derived from that declaration:

| Surface | Derivation | Notes |
| --- | --- | --- |
| MCP server | `DomainAi.toMcp(AppApi, { expose: [...] })` | One tool per call (`support_CreateTicket`); tool descriptions from `{ description }` annotations |
| HTTP API | `DomainHttp.toHttpApi(AppApi, { expose: [...] })` | Effect `HttpApi` + handlers + OpenAPI doc from the same schemas |
| CLI | `toCli(AppApi, { expose: [...] })` | Kebab-case subcommands, flags from schemas (see [cli.md](./cli.md)) |
| Typed client | `AppApi.client` | For the app's own frontend and tests |

The `expose` lists are allowlists: nothing is published unless named, and naming
something the Api doesn't serve is a type error. Adding a feature = write the
command once, add its name to the Api, add it to the `expose` lists of the
surfaces you want. HTTP routes, MCP tools, and CLI flags update themselves.

The app **template** (the "generate app" scaffold) ships: the domain skeleton,
the shared session middleware (JWT verification against the platform issuer's
JWKS — see [auth.md](./auth.md)), and the `toMcp`/`toHttpApi` hosting. The app
author only writes domain code.

Auth note: `toToolkit` forwards headers by default — an MCP server over HTTP
passes on the headers its own client sent. So gateway → child calls carry the
caller's token, and the child's middleware authorizes it. Each app authorizes
itself; the gateway never decides per-app permissions.

## The gateway (meta-MCP)

Two distinct jobs.

### 1. Registry + discovery directory — model with domain

A good fit for a domain model of its own:

- **Events/aggregate** — `AppRegistered` / `AppDeregistered` / `ToolsRefreshed`,
  an `App` aggregate keyed by app id. Free audit log of the fleet.
- **Projection** — fans out to each registered child's MCP `tools/list` (with a
  platform M2M credential) on a schedule, writing `app → tools` rows.
- **Query** — serves the aggregated directory *from the store*. This is the
  fault isolation: a down child's last-known tools stay listed (marked stale),
  and calls to it fail fast with a typed error instead of hanging the gateway.
- **Policy** — reacts to refresh failures → alerting.
- **Free ops surfaces** — `toCli` on the gateway's Api gives
  `gateway list-apps` / `gateway deregister`; `toMcp` exposes the directory
  itself as MCP tools ("what can I do with orders?").

### 2. Dynamic `tools/call` proxy — hand-written, small

Domain does **not** give us this: `Domain.Api`/`toToolkit` are statically typed
from a known Api class, and the gateway's tool set is runtime-shaped (depends on
registered children). This part is plain Effect MCP code:

- Build the gateway's tools dynamically from directory rows, namespaced
  `appname_toolname` (same scheme as domain's `toolName`).
- On `tools/call`: parse the prefix, forward to that child over Effect's MCP
  client, **passing the caller's auth headers through**.
- Per-child timeout + circuit breaker → one hanging child can't stall the
  gateway.

Keep this deliberately small. All the bookkeeping (registry, directory, audit,
alerting, ops CLI) is the domain model above; only the forwarding is bespoke.

### MCP is the discovery protocol

No custom contract format: a child's "contract" is its MCP endpoint. The gateway
calls `tools/list`; the child's tool descriptions (from `{ description }`
annotations) become the aggregated directory's docs.

## Request flows

**Discovery (async, cached):**

```
projection (schedule) ──tools/list──▶ child MCP  (platform M2M credential)
        │ writes app → tools rows
        ▼
   directory store ──query──▶ gateway MCP tools/list response
```

**Call (sync, passthrough):**

```
agent ──tools/call "support_CreateTicket"──▶ gateway
      ──verify token (JWKS, cached)──▶ parse prefix ──▶ child MCP
      (caller's headers forwarded; child's middleware authorizes)
```

## Failure modes

| Failure | Behavior |
| --- | --- |
| Child down | Directory serves last-known tools (stale); calls to it fail fast with a typed error; other apps unaffected |
| Gateway down | Apps still work directly; their own MCP/HTTP/CLI surfaces are untouched |
| Auth server down | Token *verification* is stateless JWKS (cached keys) — existing sessions keep working until expiry; no new logins |
