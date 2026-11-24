# The platform CLI

One CLI with the capabilities of every app: `platform support create-ticket …`,
`platform billing issue-refund …`.

## Why it works

Two properties of `@alchemy.run/domain` combine:

1. **The domain package is pure** — it imports only `@alchemy.run/domain` and
   `effect` (no Cloudflare, no DB drivers, no infra). So it is trivially
   publishable as an npm artifact and safe to ship inside a CLI.
2. **`toCli` composes** — each app's CLI subtree is built as a client of its
   deployed URL (`Domain.protocolHttp(url)`), and Effect's
   `Command.withSubcommands` merges them.

```ts
const platform = Command.make("platform").pipe(
  Command.withSubcommands([
    toCli(SupportApi, { expose: [...], name: "support", headers: ssoHeaders }),
    toCli(BillingApi, { expose: [...], name: "billing", headers: ssoHeaders }),
  ]),
);
```

Flags are generated from each command's schema; help text from
`{ description }` annotations. One SSO login; the `headers` option injects the
token into every call to every child (it accepts an `Effect`, so it can read a
cached token and refresh on demand).

## Publishing flow

The artifact an app "publishes back to the platform" is its **domain package**:

1. App repo publishes `@apps/support-domain` to the platform registry.
2. Platform CLI adds it as a dependency; the next release gains
   `platform support …`.

### Option: no CLI release per app

`toCli`'s static types are compile-time sugar; its runtime machinery reads the
Api class's runtime structure (the `Cliable` shape: `serves`, `group`, schemas).
So the CLI can instead:

1. `platform apps add support` → installs `@apps/support-domain`, records its URL.
2. At startup, reads the manifest and dynamically `import()`s each package,
   building subtrees untyped.

Type safety is lost at that boundary, but it works — and the manifest can come
from the same discovery directory the meta-MCP uses, so MCP aggregation and CLI
capabilities share one registry.

## The CLI does not need the gateway

The CLI can talk **directly to each child's URL** (from the manifest) rather
than routing through the gateway:

- The same SSO token verifies at every child (shared middleware).
- A dead gateway doesn't break `platform support …` — consistent with the
  fault-isolation goal.

## Per-app CLIs come free

Independent of the platform CLI, every app repo can ship its own
`support-cli` binary from the same `toCli(AppApi, …)` call — zero extra code.

## CLI auth flow

Standard OIDC for a native app (see [auth.md](./auth.md)): loopback-redirect
PKCE (open the browser, listen on localhost) or device flow where the provider
supports it. The token is cached locally and attached via `toCli`'s `headers`.

## Installing the published CLI

Anyone with repo access can install the standalone `platform` binary from the
latest `cli-v*` GitHub Release. The repo is private, so the installer uses the
`gh` CLI (authenticated) to fetch assets:

```sh
gh release download cli-v0.0.1 --repo aidansunbury/vibevarium --pattern install.sh
sh install.sh
```

`install.sh` detects OS/arch (linux-x64, darwin-arm64, darwin-x64), downloads
the matching `platform-<target>` binary plus its `.sha256`, verifies the
checksum, and installs it as `platform` into `/usr/local/bin` (or `~/.local/bin`
when `/usr/local/bin` is not writable). (See "Releasing" below for the current
version.) Then:

```sh
platform login                                    # dev-issuer login in this spike
platform apps add tickets @vibevarium/template http://127.0.0.1:3000
platform tickets open-ticket --title "…" --reporter ada
```

The published binary is the **dynamic, manifest-driven** variant. Because a
compiled single binary has no `node_modules` and cannot `import()` arbitrary
packages at runtime, the platform's domain Apis are embedded at build time and
selected by name (see `packages/cli/SPIKE.md` → "Publishing"); `apps add`
records which embedded package an app uses and where it is deployed.

## Releasing

Releases are cut with a `cli-v<version>` git tag (or `workflow_dispatch`), built
by `.github/workflows/cli-release.yml`, and published to GitHub Releases. The
version lives in `packages/cli/src/version.ts` and `packages/cli/package.json`
and must match the tag; `scripts/build.ts` enforces that agreement. See
`packages/cli/SPIKE.md` → "Publishing (GitHub Releases)" for the full flow.

## The `control` subtree (the platform's own control surface)

The control plane eats its own dogfood: the platform operations (list apps,
provision, previews, deploy history, job status) are exposed in the CLI under
the reserved `control` alias — the same surface as the `control_*` meta-MCP
tools. `control` is reserved: fleet apps are never named `control` (the control
plane's scaffold/provision/registration routes reject the name).

```sh
vibevarium control apps list          # GET /apps on the control plane
vibevarium control provision my-app   # POST /provisioning → { jobId }
vibevarium control job <jobId>        # GET /provisioning/:jobId
vibevarium control previews           # GET /previews (add --app for one parent)
vibevarium control history my-app     # GET /apps/:name/history
```

These are plain typed HTTP calls to the control plane's ops routes with the
same SSO bearer as every other subcommand.

## Connecting the CLI to production

Everything defaults to prod; no config is needed for the standard flow:

```sh
vibevarium login                # loopback-PKCE against https://auth.vibevarium.com/oidc
vibevarium control apps list    # talks to https://platform.vibevarium.com
```

The exact knobs (all optional; defaults are production):

| Env var | Default | Purpose |
| --- | --- | --- |
| `PLATFORM_OIDC_ISSUER` | `https://auth.vibevarium.com/oidc` | OIDC issuer for login + token refresh |
| `LOGTO_CLI_APP_ID` | `a4mo5zbso2lrb6nipf7hj` | The CLI's Logto native-app client id (public, PKCE only) |
| `PLATFORM_OIDC_AUDIENCE` | `https://mcp.vibevarium.com` | RFC 8707 resource indicator — the access token's audience |
| `PLATFORM_CONTROL_PLANE_URL` | `https://platform.vibevarium.com` | Base URL the `control` subtree calls |
| `TERRARIUM_CLI_CALLBACK_PORT` | `8919` | Loopback redirect port for the login flow |
| `TERRARIUM_CONFIG_DIR` | `~/.config/vibevarium` | Where `auth.json` / `apps.json` live |
| `PLATFORM_AUTH_MODE` | unset (`dev` = local dev issuer) | Set to `dev` to mint a local dev token instead of the Logto flow |

The cached session (`auth.json`) carries the access token + refresh token;
`control` subcommands refresh transparently, so after one interactive
`vibevarium login` everything (including `control`) works non-interactively
until the refresh token is revoked.

Local development against a local control plane:

```sh
PLATFORM_AUTH_MODE=dev \
PLATFORM_OIDC_ISSUER=http://127.0.0.1:4010 \
PLATFORM_OIDC_AUDIENCE=my-app \
PLATFORM_CONTROL_PLANE_URL=http://127.0.0.1:4100 \
vibevarium login && vibevarium control apps list
```
