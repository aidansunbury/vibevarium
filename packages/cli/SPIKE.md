# Mega-CLI spike

## Verdict

Both forms of the mega-CLI work locally against the real template RPC server:

- **Composed:** `platform tickets …` statically imports `TicketsApi`; its expose list is checked by TypeScript.
- **Dynamic:** `platform-dynamic tickets …` imports the Api named by `apps.json` at startup. `platform-dynamic apps add …` followed by a new process gains the subtree without changing or rebuilding the CLI.

One `platform login` mints a JWT at the dev OIDC issuer and caches it. Both executables read the same cache, and the demo proved that the exact same bearer token reached the app transport on every open/get/list RPC in both variants.

This is a spike, not a finished native auth client: login uses the issuer's `/dev/token` grant, `apps add` does not install packages, and the template still does not verify the token.

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter @terrarium/cli demo
pnpm exec tsrs --noEmit -p packages/cli/tsconfig.json
pnpm exec oxlint --type-aware packages/cli
```

The demo is the test/proof. It boots the template and dev issuer on ephemeral ports, puts a tiny logging reverse proxy in front of the template, uses an isolated config directory under `/tmp/opencode`, and cleans everything up. It asserts generated UUID ticket ids, read-your-write get/list results, `auth.json` mode `0600`, logout, and exact Authorization-header equality with the cached token. No packages outside `packages/cli` are edited.

For separate persistent processes:

```sh
pnpm --filter @terrarium/dev-issuer start  # http://127.0.0.1:4010
pnpm --filter @terrarium/template start    # http://127.0.0.1:3000

cd packages/cli
pnpm platform login
pnpm platform whoami
pnpm platform tickets open-ticket --title "VPN access" --reporter ada
pnpm platform tickets ticket-list get --key all

pnpm platform:dynamic apps add tickets @terrarium/template http://127.0.0.1:3000
pnpm platform:dynamic tickets open-ticket --title "Dynamic VPN access" --reporter ada
pnpm platform:dynamic tickets ticket-by-id get --key TICKET_ID
pnpm platform logout
```

The package also publishes `platform` (`src/main.ts`) and `platform-dynamic` (`src/dynamic.ts`) bin entries.

## Configuration and layout

Defaults:

- `~/.config/terrarium/auth.json` — cached token, identity, issuer, audience, and millisecond expiry; written with mode `0600`.
- `~/.config/terrarium/apps.json` — dynamic app manifest.
- `PLATFORM_TICKETS_URL=http://127.0.0.1:3000` — composed tickets base URL; `/rpc` is appended.
- `PLATFORM_OIDC_ISSUER=http://127.0.0.1:4010` and `PLATFORM_OIDC_AUDIENCE=my-app`.
- `PLATFORM_DEV_SUB=user-1` and `PLATFORM_DEV_NAME=Ada` control only the dev grant.
- `TERRARIUM_CONFIG_DIR` overrides the config location, primarily for isolation in the demo.

A minimal manifest entry is the shape requested by the spec:

```json
{
  "tickets": {
    "package": "@terrarium/template",
    "url": "http://127.0.0.1:3000"
  }
}
```

With no other fields, the loader requires exactly one exported value with the runtime `Cliable` shape and exposes every non-streaming operation. A package with multiple Apis can instead be explicit:

```json
{
  "tickets": {
    "package": "@terrarium/template",
    "url": "http://127.0.0.1:3000",
    "api": "TicketsApi",
    "expose": ["OpenTicket", "CloseTicket", "TicketById.get", "TicketList.get"]
  }
}
```

The package must already be resolvable by Node (a workspace dependency here, or installed by a real package manager in a product). `apps add` only writes the manifest.

Source layout:

- `src/composed.ts` — type-safe `TicketsApi` subtree and static root composition.
- `src/apps.ts` — manifest schema, `apps add`, runtime Api discovery, dynamic subtree construction.
- `src/auth.ts` — dev grant, cached session, login/logout/whoami, per-call headers, authenticated RPC transport.
- `src/config.ts` — paths and private JSON writes.
- `src/main.ts` / `src/dynamic.ts` — the two executables.
- `scripts/demo.ts` — runnable proof and header-capture proxy.

## What the two variants buy

| Composed | Dynamic |
| --- | --- |
| Api and expose names are type-checked; refactoring catches drift. | Only the runtime `Cliable` shape remains; bad packages/exports/expose names fail at runtime. |
| Adding/updating an app means changing dependencies and releasing the CLI. | An installed package plus one manifest write is enough; the next invocation has the subtree. |
| Imports and dependency versions are reviewed with the CLI release. | Manifest-driven code loading needs an installation, versioning, and trust story. |
| Startup loads the statically selected apps. | Startup reads and imports every manifest app, including for help/login; one broken import currently prevents the whole invocation. |
| Best default for a controlled platform release. | Best discovery/directory experiment and likely best companion to the meta-MCP registry. |

Per-app URLs work because each `toCli` subtree is wrapped in its own `Command.provide(authenticatedProtocol(appUrl + "/rpc"))`; a single process-wide `Domain.protocolHttp` would not be enough for a multi-app fleet.

## `toCli` / Effect beta.87 quirks hit

1. **The CLI speaks Effect RPC, not the generated REST routes.** As in the template spike, the app must mount the Api at `/rpc`; these CLIs append that path to each configured base URL.
2. **Zero-field commands still need the workaround.** `CloseTicket` gets no `input` object from generated flags. Use:

   ```sh
   platform tickets close-ticket --target TICKET_ID --json '{"input":{}}'
   ```

   `toCli` should emit `input: {}` itself for this shape.
3. **Important new finding: `toCli({ headers })` does not produce an HTTP header.** The option is evaluated correctly and its value reaches Effect RPC as `message.headers`, but `RpcClient`'s `makeHttpExchange` serializes those headers into the NDJSON RPC envelope and calls `client.post` without copying them to the HTTP request. The first version of this demo therefore returned tickets while the proxy observed `authorization: undefined`.

   The spike keeps `headers: ssoHeaders` on every `toCli` call and adds `ssoProtocolHttp`, a local equivalent of `Domain.protocolHttp` whose effectful `HttpClient` request mapper attaches the same cached token as `Authorization: Bearer …`. This is why the demo now proves actual transport-level receipt. The adapter currently reads the cache once for `toCli` and once for the HTTP mapper. Upstream should provide a supported way to propagate RPC headers to the HTTP request (or document the intended HTTP-auth middleware), after which this workaround can be deleted.
4. **`toCli` has no per-app URL option.** URL selection lives in the RPC protocol service. Effect's `Command.provide` applies a layer to a whole command subtree and solves this cleanly; a single global protocol layer would target only one app.
5. **The dynamic expose type collapses.** `Exposable<Cliable>` is `never` because the untyped Api's client is unknown. The dynamic adapter contains one explicit cast for its runtime string expose list and hides the resulting `any` service type behind a concrete command type. The composed path needs no cast.
6. **Default dynamic exposure relies on runtime helpers.** `operationsOf` / `callName` from `ReadRpcs` derive all non-streaming names. A supported `toCli` default-exposure helper would avoid coupling the manifest loader to that runtime module.
7. **Domain package entrypoints matter.** The composed CLI imports `@terrarium/template/TicketsApi.api` directly so it does not pull the template's HTTP/MCP server through the root barrel. Published app packages should expose a similarly small, pure domain entrypoint.

## What real OIDC login swaps in

`mintDevSession` in `src/auth.ts` is the seam. Replace its `/dev/token` fetch with standard loopback-redirect authorization-code PKCE:

1. Read issuer discovery.
2. Generate state, nonce, and a PKCE verifier/challenge.
3. Listen on loopback, open the browser at the authorization endpoint, and validate the callback state.
4. Exchange the code at the token endpoint, validate the ID token, and write the same `CachedSession` shape.

`login`/`whoami`, the cached token format, `toCli` headers, and per-app transport do not need to change. A real implementation should also add refresh-token handling (secure storage and refresh near expiry), rather than today's explicit “run platform login” on expiry. A system keychain may be preferable to a `0600` JSON file outside the spike.

Missing and expired sessions fail before any network call, for example:

```text
ERROR
  No cached SSO session; run platform login.

ERROR
  SSO token expired at 1970-01-01T00:00:00.001Z; run platform login.
```

## Proof from the final demo run

The full command was `pnpm --filter @terrarium/cli demo`. These are unedited command labels, ticket ids, and outputs from that run; only the bearer token is redacted.

### One login, shared by both variants

```console
$ platform login
Logged in as Ada (user-1); token expires 2026-11-21T02:29:42.106Z.

auth.json mode: 0600

$ platform-dynamic apps add tickets @terrarium/template http://127.0.0.1:41737
Added tickets: @terrarium/template at http://127.0.0.1:41737

$ platform-dynamic whoami
{
  "subject": "user-1"
}
```

(`whoami` actually prints issuer, audience, name, and expiry too; the demo report retains the subject it asserts.)

### Composed subtree

```console
$ platform tickets open-ticket --title "composed mega-CLI ticket" --reporter ada
{
  "reply": null,
  "stream": "Ticket/f729280f-f7fc-4ad8-9bc9-2966bdeb436a",
  "version": 1
}

$ platform tickets ticket-by-id get --key f729280f-f7fc-4ad8-9bc9-2966bdeb436a --at-least '{"stream":"Ticket/f729280f-f7fc-4ad8-9bc9-2966bdeb436a","version":1}'
{
  "id": "f729280f-f7fc-4ad8-9bc9-2966bdeb436a",
  "title": "composed mega-CLI ticket",
  "reporter": "ada",
  "status": "open"
}
```

The following `platform tickets ticket-list get --key all …` output contained that same id. Header evidence captured by the proxy in front of the real template for open, get, and list respectively:

```json
[
  { "method": "POST", "path": "/rpc/", "authorization": "Bearer eyJhbGciOiJSUzI1NiIsImtp…<redacted>", "matchesCachedToken": true },
  { "method": "POST", "path": "/rpc/", "authorization": "Bearer eyJhbGciOiJSUzI1NiIsImtp…<redacted>", "matchesCachedToken": true },
  { "method": "POST", "path": "/rpc/", "authorization": "Bearer eyJhbGciOiJSUzI1NiIsImtp…<redacted>", "matchesCachedToken": true }
]
```

### Dynamic subtree, after `apps add` and without a CLI rebuild

```console
$ platform-dynamic tickets open-ticket --title "dynamic mega-CLI ticket" --reporter ada
{
  "reply": null,
  "stream": "Ticket/1d4bb1ee-b1cd-49a8-a8c3-44bd479631c8",
  "version": 1
}

$ platform-dynamic tickets ticket-by-id get --key 1d4bb1ee-b1cd-49a8-a8c3-44bd479631c8 --at-least '{"stream":"Ticket/1d4bb1ee-b1cd-49a8-a8c3-44bd479631c8","version":1}'
{
  "id": "1d4bb1ee-b1cd-49a8-a8c3-44bd479631c8",
  "title": "dynamic mega-CLI ticket",
  "reporter": "ada",
  "status": "open"
}
```

The following `platform-dynamic tickets ticket-list get --key all …` output contained both the composed id and the new dynamic id. Its three observed headers were also exact matches for the original login token:

```json
[
  { "method": "POST", "path": "/rpc/", "authorization": "Bearer eyJhbGciOiJSUzI1NiIsImtp…<redacted>", "matchesCachedToken": true },
  { "method": "POST", "path": "/rpc/", "authorization": "Bearer eyJhbGciOiJSUzI1NiIsImtp…<redacted>", "matchesCachedToken": true },
  { "method": "POST", "path": "/rpc/", "authorization": "Bearer eyJhbGciOiJSUzI1NiIsImtp…<redacted>", "matchesCachedToken": true }
]
```

Final demo result and logout:

```text
PASS: both variants returned real ticket ids and every RPC carried the same SSO bearer token
Logged out; cached SSO token removed.
```

Final `tsrs` and type-aware `oxlint` runs both completed with no output/errors. No test suite was added because the executable demo covers the behavior, including the transport detail a pure composition test would miss.

## Open questions

- Should upstream HTTP RPC propagate per-call headers, or should Terrarium standardize a reusable authenticated protocol layer for every derived CLI?
- Should the dynamic manifest and meta-MCP discovery directory be one registry record, including URL, package version/integrity, Api export, expose policy, and expected audience?
- Who installs and upgrades dynamic domain packages, and how are they trusted? `apps add` deliberately does not solve this.
- Should dynamic imports be lazy/failure-isolated so a broken package cannot block login, help, and healthy app subtrees?
- What is the safe default exposure for an arbitrary Api: all non-streaming calls, only commands plus `.get`, or an explicit manifest list?
- Will one audience really be accepted by every app, or does SSO need per-resource token exchange/down-scoping?
- Can published app packages guarantee a pure domain-only entrypoint so CLI installation cannot accidentally pull server/cloud dependencies?
