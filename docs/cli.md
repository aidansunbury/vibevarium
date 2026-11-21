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
