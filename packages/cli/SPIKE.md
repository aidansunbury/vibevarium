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
pnpm --filter @vibevarium/cli demo
pnpm exec tsrs --noEmit -p packages/cli/tsconfig.json
pnpm exec oxlint --type-aware packages/cli
```

The demo is the test/proof. It boots the template and dev issuer on ephemeral ports, puts a tiny logging reverse proxy in front of the template, uses an isolated config directory under `/tmp/opencode`, and cleans everything up. It asserts generated UUID ticket ids, read-your-write get/list results, `auth.json` mode `0600`, logout, and exact Authorization-header equality with the cached token. No packages outside `packages/cli` are edited.

For separate persistent processes:

```sh
pnpm --filter @vibevarium/dev-issuer start  # http://127.0.0.1:4010
pnpm --filter @vibevarium/template start    # http://127.0.0.1:3000

cd packages/cli
pnpm platform login
pnpm platform whoami
pnpm platform tickets open-ticket --title "VPN access" --reporter ada
pnpm platform tickets ticket-list get --key all

pnpm platform:dynamic apps add tickets @vibevarium/template http://127.0.0.1:3000
pnpm platform:dynamic tickets open-ticket --title "Dynamic VPN access" --reporter ada
pnpm platform:dynamic tickets ticket-by-id get --key TICKET_ID
pnpm platform logout
```

The package also publishes `platform` (`src/main.ts`) and `platform-dynamic` (`src/dynamic.ts`) bin entries.

## Configuration and layout

Defaults:

- `~/.config/vibevarium/auth.json` — cached token, identity, issuer, audience, and millisecond expiry; written with mode `0600`.
- `~/.config/vibevarium/apps.json` — dynamic app manifest.
- `PLATFORM_TICKETS_URL=http://127.0.0.1:3000` — composed tickets base URL; `/rpc` is appended.
- `PLATFORM_OIDC_ISSUER=http://127.0.0.1:4010` and `PLATFORM_OIDC_AUDIENCE=my-app`.
- `PLATFORM_DEV_SUB=user-1` and `PLATFORM_DEV_NAME=Ada` control only the dev grant.
- `TERRARIUM_CONFIG_DIR` overrides the config location, primarily for isolation in the demo.

A minimal manifest entry is the shape requested by the spec:

```json
{
  "tickets": {
    "package": "@vibevarium/template",
    "url": "http://127.0.0.1:3000"
  }
}
```

With no other fields, the loader requires exactly one exported value with the runtime `Cliable` shape and exposes every non-streaming operation. A package with multiple Apis can instead be explicit:

```json
{
  "tickets": {
    "package": "@vibevarium/template",
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
7. **Domain package entrypoints matter.** The composed CLI imports `@vibevarium/template/TicketsApi.api` directly so it does not pull the template's HTTP/MCP server through the root barrel. Published app packages should expose a similarly small, pure domain entrypoint.

## Real OIDC login (implemented)

`src/auth.ts` now does the real loopback-redirect authorization-code PKCE flow against the hosted Logto tenant (no client secret — the CLI is a native/public app):

1. Reads issuer discovery (`https://auth.vibevarium.com/oidc` by default, `PLATFORM_OIDC_ISSUER` overrides).
2. Generates state and a PKCE S256 verifier/challenge.
3. Listens on `127.0.0.1:8919`, opens the browser at `/oidc/auth` (scope `openid profile offline_access member admin apps:read apps:write`, RFC 8707 `resource=https://api.vibevarium.com/mcp`, `prompt=consent` so `offline_access` yields a refresh token), and validates the callback state.
4. Exchanges the code at `/oidc/token` — repeating the `resource` indicator, which is what makes Logto issue a JWT access token audience-restricted to the platform API — decodes the ID-token claims, and writes `CachedSession` (now v2, with `refreshToken` + `idToken`) to `~/.config/vibevarium/auth.json` (0600).
5. `requireSession` transparently refreshes via the `refresh_token` grant when the access token is expired; `platform logout` revokes the refresh token and clears the cache. `whoami` decodes the cached ID-token claims.

The dev issuer is kept as an explicit fallback: `PLATFORM_AUTH_MODE=dev` uses the old `/dev/token` grant (the existing `scripts/demo.ts` runs this way). `ssoHeaders`/`ssoProtocolHttp`/per-app transport are unchanged. Proof against the live tenant: `scripts/login-demo.ts` (registers/signs in a test user via Logto's Experience API so no human click is needed).

Missing and expired sessions fail before any network call, for example:

```text
ERROR
  No cached SSO session; run platform login.

ERROR
  SSO token expired at 1970-01-01T00:00:00.001Z; run platform login.
```

## Proof from the final demo run

The full command was `pnpm --filter @vibevarium/cli demo`. These are unedited command labels, ticket ids, and outputs from that run; only the bearer token is redacted.

### One login, shared by both variants

```console
$ platform login
Logged in as Ada (user-1); token expires 2026-11-21T02:29:42.106Z.

auth.json mode: 0600

$ platform-dynamic apps add tickets @vibevarium/template http://127.0.0.1:41737
Added tickets: @vibevarium/template at http://127.0.0.1:41737

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

- Should upstream HTTP RPC propagate per-call headers, or should Vibevarium standardize a reusable authenticated protocol layer for every derived CLI?
- Should the dynamic manifest and meta-MCP discovery directory be one registry record, including URL, package version/integrity, Api export, expose policy, and expected audience?
- Who installs and upgrades dynamic domain packages, and how are they trusted? `apps add` deliberately does not solve this.
- Should dynamic imports be lazy/failure-isolated so a broken package cannot block login, help, and healthy app subtrees?
- What is the safe default exposure for an arbitrary Api: all non-streaming calls, only commands plus `.get`, or an explicit manifest list?
- Will one audience really be accepted by every app, or does SSO need per-resource token exchange/down-scoping?
- Can published app packages guarantee a pure domain-only entrypoint so CLI installation cannot accidentally pull server/cloud dependencies?

## Publishing (GitHub Releases)

The published artifact is the **dynamic, manifest-driven** variant, shipped as a
single `platform` binary per OS/arch via GitHub Releases (`.github/workflows/cli-release.yml`).
The composed variant stays a workspace dev tool: publishing it would bake the
whole workspace into every release and give no `apps add` flexibility.

### The compiled-binary loading constraint (decided: embedded registry)

The spike's dynamic loader `import()`ed a bare package specifier resolved from
the workspace `node_modules`. A `bun build --compile` single binary has **no
`node_modules`** and no runtime module resolution against disk, so that loader
cannot load an arbitrary npm/tarball package. Three approaches were tried and
rejected:

1. **Fetch + extract a tarball, then `import()` the extracted `.ts`.** Fails:
   the extracted package imports `@alchemy.run/domain`/`effect`, and a compiled
   binary cannot resolve those bare specifiers from disk. Symlinking the
   binary's embedded `/$bunfs/root/node_modules` does not work — that virtual
   path is not visible to `node:fs`/`symlink` from inside the binary.
2. **A `Bun.plugin` runtime resolver** redirecting the package's deps to the
   embedded modules. `Bun.plugin` exists in compiled binaries, but the hook is
   applied at build time, not for post-build runtime `import()`, so it cannot
   cover packages added after the binary was built.
3. **Publish domain packages to npm and install them.** Same resolution
   problem as (1) once installed.

The decision is an **embedded Api registry** (`src/registry.ts`): the platform's
known domain Apis are statically imported at build time (so they and their deps
are bundled and resolve correctly), and `apps add <name> <package> <url>`
records which registry key an app uses. The manifest still decides *which* apps
are exposed and their URLs; the registry decides *which Api code* backs each
package name. Adding a new app to a release means adding one import + entry to
`src/registry.ts` and cutting a new CLI release — acceptable because the
platform controls both.

This is a deliberate simplification of the "no CLI release per app" goal: the
manifest no longer pulls in arbitrary code, but it still adds/removes apps and
repoints URLs without touching the CLI's *composition* code. When the app
registry moves to the control plane, `src/registry.ts` becomes a fetched
manifest plus lazy per-app bundles instead of a static import list.

### Version stamp

`src/version.ts` (`cliVersion`) is the single source of truth; it must equal
`package.json`'s `version` and the release tag's version (`cli-v<X>`).
`scripts/build.ts --version <X>` asserts all three agree before compiling, so a
published binary's `--version` can never disagree with its tag.

### Cutting a release

```sh
git tag cli-v0.0.2          # after bumping package.json + src/version.ts
git push origin cli-v0.0.2  # triggers cli-release.yml
# or: gh workflow run cli-release.yml -f version=0.0.2
```

The workflow builds `platform-linux-x64`, `platform-darwin-arm64`,
`platform-darwin-x64` (+ `.sha256`), substitutes `scripts/install.sh` with the
repo + version, and attaches everything to a `cli-v<X>` GitHub Release. The
repo is private, so `install.sh` uses the `gh` CLI to download assets (a plain
`curl` against the browser download URL returns 404 without auth).
