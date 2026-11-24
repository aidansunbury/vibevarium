# Customizing your vibevarium

Everything here is config, not code — vibevarium is built around swappable
providers behind fixed interfaces. This is the reference for the knobs.

## The domain knob

One variable re-roots the whole instance:

```bash
TERRARIUM_DOMAIN=internal.yourcompany.com
```

Every hostname derives from it: `auth.$TERRARIUM_DOMAIN` (the OIDC issuer),
`platform.$TERRARIUM_DOMAIN` (the control plane GUI + API), and every app at
`<name>.$TERRARIUM_DOMAIN`. Change it and re-run `packages/infra/scripts/deploy.sh`
— DNS, Caddy routes, OIDC issuer, and app hostnames all follow.

## Auth providers

The auth boundary is **OIDC-only** — no vendor SDKs anywhere. Swapping the
identity provider is issuer + audience config:

```bash
# .env / Secrets Manager
TERRARIUM_AUTH_PROVIDER=casdoor        # or workos, or any OIDC issuer
TERRARIUM_ISSUER=https://auth.$TERRARIUM_DOMAIN
PLATFORM_OIDC_AUDIENCE=https://mcp.$TERRARIUM_DOMAIN
```

| Provider | Notes |
|---|---|
| **Casdoor** (default) | Self-hosted, Apache-2.0, supports RFC 7591 dynamic client registration — per-app OIDC clients are created with one DCR call. Runs beside the control plane in the same compose stack. |
| **WorkOS AuthKit** | Managed; set `WORKOS_CLIENT_ID` + `WORKOS_API_KEY` in Secrets Manager. Enable CIMD + DCR in the WorkOS dashboard. |
| **Keycloak / Authentik / your SSO** | Anything that speaks OIDC with DCR works; point `TERRARIUM_ISSUER` at it. |

The rule that makes this safe: **apps accept tokens by audience, and the
issuer is config** — so a provider swap touches nothing in app code.

## Secrets

All secrets live in **AWS Secrets Manager** under a prefix (default
`/vibevarium/prod/`), read at boot by the control plane's instance profile.
Zero secret env vars on the box.

### The naming convention

```
/vibevarium/prod/<vendor>-<purpose>[-<qualifier>]   # lower-kebab-case
```

### What the control plane reads at boot

| SM name | Env var it fills | What it's for |
|---|---|---|
| `github-app-id` / `github-app-private-key` | `GITHUB_APP_*` | The GitHub App that creates app repos |
| `cloudflare-api-token` | `CLOUDFLARE_API_TOKEN` | Deploying app Workers + DNS |
| `gui-app-id` / `gui-app-secret` | `GUI_APP_*` | The control plane GUI's own OIDC client |
| `github-oauth-client-id` / `-secret` | `GITHUB_OAUTH_CLIENT_*` | The GitHub **connection** (below) |
| `linear-oauth-client-id` / `-secret` | `LINEAR_OAUTH_CLIENT_*` | The Linear connection |
| `connections-token-encryption-key` | `CONNECTIONS_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for provider tokens at rest |
| `database-url` | `DATABASE_URL` | The RDS `postgres://…` URL |
| `casdoor-admin-password` | (deploy-time) | Casdoor's bootstrap admin password |

### Adding a secret

1. Put it in SM under the prefix:
   `aws secretsmanager create-secret --name /vibevarium/prod/stripe-secret-key --secret-string …`
2. If it's **boot config**, add a row to `AWS_BOOT_SECRETS` in
   `packages/control-plane/src/secrets/boot.ts` and redeploy.
3. If it's an **integration token** (used by the proxy), nothing to redeploy —
   integrations reference it by name and it's resolved per-call with a 60s
   cache.

Verify what's resolving (names only, never values):
`curl https://platform.$TERRARIUM_DOMAIN/config-check`

## Connections

Connect a provider (GitHub, Linear, …) once; apps get per-app grants and the
control plane brokers tokens through one credential-holding proxy.

### Registering a provider's OAuth app

Create the OAuth app in the provider's dashboard with **one shared callback**:

```
https://platform.$TERRARIUM_DOMAIN/connections/callback
```

(When the API moves to `api.$TERRARIUM_DOMAIN`, use that host instead.)

- **GitHub**: Settings → Developer settings → OAuth Apps → New.
- **Linear**: Settings → API → OAuth applications → New. Scopes are
  comma-separated (`read,write`); identity is GraphQL.

Then put the client id/secret in Secrets Manager (table above) and restart —
the provider registers at boot when both refs resolve.

### Adding a brand-new provider

Providers are **data, not code** — add one entry to
`packages/control-plane/src/connections/manifest.ts`:

```ts
export const SLACK_PROVIDER: ProviderManifestEntry = {
  name: "slack",
  displayName: "Slack",
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  userinfoUrl: "https://slack.com/api/auth.test",
  apiBaseUrl: "https://slack.com/api",
  clientIdRef: "SLACK_OAUTH_CLIENT_ID",
  clientSecretRef: "SLACK_OAUTH_CLIENT_SECRET",
  defaultScopes: ["channels:read"],
  responseMode: "query",
};
```

The generic flow handles OIDC/GitHub-shaped identity. If a provider's identity
endpoint is unusual (Linear's GraphQL, say), pass a `fetchIdentity` hook in the
manifest entry — see `LINEAR_PROVIDER` for the pattern.

## Theming

The design system is **botanical print** — Fraunces serif display over Source
Sans 3, in a light/dark palette pair (**Vellum** / **Graphite**), WCAG-audited
to AA/AAA. The spec: [assets/branding/BRAND.md](../assets/branding/BRAND.md).

- **Design tokens**: `packages/ui/src/styles/globals.css` (CSS custom
  properties; the landing page inlines the same tokens to stay self-contained).
- **Components**: `@vibevarium/ui` — shadcn + Base UI, Tailwind v4.
- **The mark**: `assets/branding/logo.svg` — also as `Logo` / `LogoLockup`
  components in `@vibevarium/ui`.

To re-skin your instance, edit the token values in `globals.css`; every app and
the control-plane GUI picks them up from the same source.

## The CLI

```bash
vibevarium grow my-app     # scaffold a new app
vibevarium ls              # what's growing
```

The CLI composes each app's own CLI (and dynamically imports MCP tool schemas)
so humans and agents share one interface. Rename the binary with
`TERRARIUM_CLI_NAME` if `vibevarium` collides with something on your PATH.

## Templates

Every app grows from `packages/template-cloudflare/`: a React SPA + typed
Effect backend on Cloudflare Worker + D1. Templates vary the **starting
shape**, never the contract — a domain package, an Api declaration, auth
middleware, a deploy stack. Options (an R2 bucket, a queue) are feature flags
inside a template, not new templates. To change what "a new app" means for your
org, fork the template.
