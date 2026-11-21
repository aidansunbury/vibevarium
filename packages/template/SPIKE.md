# Tickets derived-surface spike

## Verdict

The thesis works locally. One `TicketsApi` declaration drives:

- a JSON HTTP API and `/openapi.json` via `toHttpApi`;
- streamable-HTTP MCP at `/mcp` via `toMcp` (Effect MCP protocol `2025-11-25`);
- an executable CLI via `toCli`, using `Domain.protocolHttp` against `/rpc`.

The aggregate and both views run on `Domain.InMemory` in a plain Node process. No cloud credentials, Docker, Bun, frontend, or database are involved. Optional OIDC auth now uses `@terrarium/auth`; the original demo remains unauthenticated by default, and the control-plane scaffold demo exercises authenticated mode. TypeScript execution consistently uses `node --experimental-strip-types`.

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter @terrarium/template demo
pnpm --filter @terrarium/template test
pnpm exec tsrs --noEmit -p packages/template/tsconfig.json
```

The demo boots an ephemeral localhost port, exercises all three surfaces, and prints the complete results. Current verification: **2 tests passed; tsrs completed with no errors**.

To run a persistent server and the executable directly:

```sh
pnpm --filter @terrarium/template start  # http://127.0.0.1:3000; override with PORT
cd packages/template
./src/cli.ts open-ticket --title "VPN access" --reporter carol
./src/cli.ts ticket-list get --key all
# `pnpm tickets ...` is the equivalent package-script invocation.
```

Plain HTTP examples:

```sh
curl http://127.0.0.1:3000/openapi.json
curl -X POST http://127.0.0.1:3000/OpenTicket \
  -H 'content-type: application/json' \
  -d '{"target":"http-1","input":{"title":"Printer offline","reporter":"alice"}}'
curl http://127.0.0.1:3000/TicketById/http-1
```

## Optional OIDC auth

Setting `TERRARIUM_ISSUER` enables `@terrarium/auth` verification for the HTTP API, OpenAPI, RPC, and MCP. `TERRARIUM_AUDIENCE` defaults to `${APP_NAME:-tickets}.terrarium.local`; `TERRARIUM_AUTH=off` explicitly preserves unauthenticated local demos even when an issuer is present. `/health` is public, while `GET /whoami` echoes the verified `CurrentActor`.

For example, with the dev issuer running on port 4010 and `expenses.terrarium.local` in its allowed audiences:

```sh
TERRARIUM_AUTH=on \
TERRARIUM_ISSUER=http://127.0.0.1:4010 \
TERRARIUM_AUDIENCE=expenses.terrarium.local \
APP_NAME=expenses \
pnpm --filter @terrarium/template start

TOKEN=$(curl -s 'http://127.0.0.1:4010/dev/token?sub=user-1&name=Ada&aud=expenses.terrarium.local' | node -pe 'JSON.parse(require("node:fs").readFileSync(0)).access_token')
curl -i http://127.0.0.1:3000/whoami                    # 401
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/whoami
```

The complete automated authenticated proof is `pnpm --filter @terrarium/control-plane scaffold:demo`; see `packages/control-plane/SCAFFOLD-SPIKE.md`.

## What was built

- `Ticket` aggregate, keyed by `TicketId`, with pure `decide`/`evolve` functions.
- `OpenTicket` / `CloseTicket`, `TicketOpened` / `TicketClosed`, and typed `TicketAlreadyOpen`, `TicketAlreadyClosed`, and `TicketNotFound` rejections.
- `TicketById` and singleton-keyed `TicketList` views.
- `TicketsModel` and one `TicketsApi`; every domain declaration has a `description`.
- One shared exposure allowlist for commands and view reads in `src/surfaces.ts`.
- `src/server.ts` hosts all surfaces; `src/cli.ts` is the executable; `src/demo.ts` plus `test/derived-surfaces.test.ts` proves them.
- `src/server.ts` wraps the final router with shared OIDC auth (except public `/health`) and exposes `GET /whoami` to echo `CurrentActor`. The list view has a Drizzle TODO; this spike needs no store beyond the in-memory domain platform.

## Real proof output

The following are excerpts from the successful final `pnpm demo`; the command prints the complete schemas and results.

### HTTP command + reads

```json
{
  "opened": { "reply": null, "stream": "Ticket/http-1", "version": 1 },
  "closed": { "reply": null, "stream": "Ticket/http-1", "version": 2 },
  "byId": {
    "id": "http-1",
    "title": "Printer is offline",
    "reporter": "alice",
    "status": "closed"
  },
  "list": {
    "tickets": [
      {
        "id": "http-1",
        "title": "Printer is offline",
        "reporter": "alice",
        "status": "closed"
      }
    ]
  }
}
```

The reads use `?stream=Ticket/http-1&version=2`, proving `atLeast` read-your-write consistency rather than relying on a sleep.

### MCP `tools/list`

These are the real `result.tools` names, descriptions, and annotations; the demo also prints every generated input/output schema (the view filter schemas are large).

```json
[
  {
    "name": "TicketsApi_OpenTicket_send",
    "description": "Open a support ticket, generating its id when --target is omitted.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "TicketsApi_CloseTicket_send",
    "description": "Close an open support ticket.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "TicketsApi_TicketById_get",
    "description": "Get the current TicketById of a key. The current title, reporter, and status of one ticket.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "TicketsApi_TicketList_get",
    "description": "Get the current TicketList of a key. All tickets under the singleton `all` key.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  }
]
```

`tools/call TicketsApi_OpenTicket_send` returned:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"reply\":null,\"stream\":\"Ticket/mcp-1\",\"version\":1}"
    }
  ],
  "structuredContent": {
    "reply": null,
    "stream": "Ticket/mcp-1",
    "version": 1
  },
  "isError": false
}
```

A second MCP call read the ticket back:

```json
{
  "structuredContent": {
    "value": {
      "id": "mcp-1",
      "title": "Password reset is stuck",
      "reporter": "bob",
      "status": "open"
    }
  },
  "isError": false
}
```

### OpenAPI paths

```text
POST /OpenTicket         TicketsApi.OpenTicket         200, 409
POST /CloseTicket        TicketsApi.CloseTicket        200, 404, 409
GET  /TicketById/{key}   TicketsApi.TicketById.get     200, 422
GET  /TicketList/{key}   TicketsApi.TicketList.get     200, 422
GET  /openapi.json       generated document
```

The generated document's `info.description` is `Open, close, and inspect support tickets.` Rejection annotations produced the 404/409 responses, and view consistency timeouts produced 422.

### CLI

Real `./src/cli.ts --help` output (global flags omitted here):

```text
DESCRIPTION
  Open, close, and inspect support tickets.

USAGE
  tickets <subcommand> [flags]

SUBCOMMANDS
  open-ticket     Open a support ticket, generating its id when --target is omitted.
  close-ticket    Close an open support ticket.
  ticket-by-id    The current title, reporter, and status of one ticket.
  ticket-list     All tickets under the singleton `all` key.
```

The required no-target invocation worked through the real executable and the running HTTP RPC server:

```console
$ tickets open-ticket --title "VPN access is missing" --reporter carol
{
  "reply": null,
  "stream": "Ticket/dda4e4c0-9c17-4ca7-88f5-016629a3c269",
  "version": 1
}
```

The demo then closed that ticket and read it back through the CLI:

```json
{
  "id": "dda4e4c0-9c17-4ca7-88f5-016629a3c269",
  "title": "VPN access is missing",
  "reporter": "carol",
  "status": "closed"
}
```

## Awkward or missing in `@alchemy.run/domain` beta.87

1. **The CLI does not call the `toHttpApi` routes.** `Domain.protocolHttp` speaks the Api's Effect RPC/NDJSON protocol. The Node host therefore mounts `yield* TicketsApi` at `/rpc`, `toHttpApi` at its own routes, and MCP at `/mcp`. A small first-party Node host combining all three would remove the least obvious wiring in this spike.
2. **Zero-field commands need a CLI workaround.** `tickets close-ticket --target ID` fails client-side with `Missing key at ["input"]`: `toCli` only creates `input` when the command has input fields, while the RPC payload requires it. The demo uses `--json '{"input":{}}` for close. `toCli` should emit `input: {}` for zero-field commands.
3. **Create-with-generated-id is not a first-class command shape.** Every command has a target. `NewTicketId` uses `Schema.withDecodingDefaultKey` so `OpenTicket` can omit it and generate a UUID. This works on HTTP, MCP, and CLI, but the ownership and timing of id generation should be made explicit in a real template.
4. **MCP read schemas are much larger than expected.** View tools expose the generic `where` filter even though `toHttpApi` deliberately does not publish `where`. Besides the payload size, the surfaces have different read capabilities. Consider a way to exclude filters per surface.
5. **OpenAPI metadata needs adjustment.** `/openapi.json` has `info.title: "Api"`, not `TicketsApi`; the Api description does propagate correctly. A real template will want a documented way to set title/version without hand-editing generated output.
6. **Nullable view results are wrapped for MCP.** `TicketById.get` returns `{ value: ... }`, since MCP structured output must be an object. This is documented behavior, but clients need to know it.

## Open questions

- Should the template standardize generated ids in the command schema, require caller ids, or add an aggregate creation convention?
- HTTP middleware now protects every hosted surface. Should Domain command/view middleware also receive `CurrentActor` for domain-level authorization, or should authorization remain in HTTP handlers?
- For persistent apps, should a cross-ticket list remain a singleton view or become a paged `Query` over a Drizzle projection? The in-memory view was sufficient for this derivation proof.
- Can the platform provide a Drizzle-backed local `Domain.Platform`, or should persistence be introduced per projection while commands remain on the existing platform?
