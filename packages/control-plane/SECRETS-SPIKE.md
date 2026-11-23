# Secrets spike — AWS Secrets Manager behind the SecretsProvider seam

Two layers, one seam. **No secret values ever appear in env files, compose
files, logs, or any endpoint — names only.**

## The two layers

### 1. Boot config layer (`src/secrets/boot.ts`)

Resolves the control plane's *own* runtime config (GitHub App credentials,
Cloudflare API token, Logto app credentials) before any config is read.

`main.ts` starts with `await loadBootSecrets()`. When `SECRETS_PROVIDER=aws`:

1. Every key in `AWS_BOOT_SECRETS` (SM name → env var name) is fetched with
   `GetSecretValue` under `SECRETS_PREFIX` (default `/terrarium/prod/`) — one
   parallel batch at boot, before the HTTP server or any layer builds.
2. Values are injected into `process.env` **only when the var is unset** — a
   real environment variable always wins, so local overrides keep working.
3. Every existing consumer (`main.ts`'s env reads, `router-directory.ts`'s
   `CLOUDFLARE_API_TOKEN`, …) works unchanged in both modes.

Boot order rationale: the config is plain `process.env.X` reads scattered
through module scope and option builders. Refactoring all of that into an
Effect `Config` layer is a bigger change than the spike calls for; injecting
into env at boot keeps `env` and `aws` modes behaviorally identical downstream.
The fetch happens *before* `Layer.launch`, so no service ever builds with
half-resolved config.

The GitHub App private key arrives inline (`GITHUB_APP_PRIVATE_KEY`, PEM
string) instead of as a file path (`GITHUB_APP_PRIVATE_KEY_PATH`); the scaffold
`github` option accepts either (`privateKey` wins when both are set).

### 2. Proxy-time layer (`src/integrations/secrets.ts` — the existing seam)

Integration tokens resolved per proxied call (`Integrations.proxy` →
`secrets.resolve(tokenEnv)`). `SecretsProvider.awsLayer({ prefix })` maps a
tokenEnv reference to an SM secret name under the prefix, with:

- **In-memory cache, 60s TTL.** Proxy calls are per-request and can be hot;
  SM is metered per call and rate-limited. 60s bounds token-rotation
  propagation to a minute — slow enough to keep SM traffic negligible, fast
  enough that rotation without a redeploy actually takes effect. Tune with
  `cacheTtlMs`.
- **Per-entry miss → fetch.** A cache miss (or expiry) fetches just that
  secret; there's no background refresh, keeping the failure mode "one
  proxy call gets 502 secret_unavailable" instead of "layer dies".
- **All fetch errors → `Option.none`.** ResourceNotFound / AccessDenied /
  DecryptionFailure all surface to the caller as the existing
  `502 secret_unavailable` path — the provider never throws into the proxy.

### Selection and fallback

`SECRETS_PROVIDER=aws|env`, default `env` (local dev unchanged).

Both layers check for discoverable AWS credentials first: static keys,
`AWS_PROFILE`, web-identity/IRSA, ECS container credentials, or the IMDS
default chain (`AWS_EC2_METADATA_DISABLED !== "true"` — the EC2 instance
profile). With no credentials, `aws` mode degrades to env resolution with a
warning instead of crashing the process — a dev machine without SSO keeps
working.

## IAM shape

The EC2 instance carries an instance profile
(`packages/infra/src/aws.ts: Ec2Role + Ec2Profile`), trust policy
`ec2.amazonaws.com`, one inline policy:

```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
  "Resource": ["arn:aws:secretsmanager:us-east-1:412215357683:secret:/terrarium/prod/*"]
}
```

Path-scoped, not tag-scoped: SM resource ARNs embed the secret name, so the
`/terrarium/prod/*` prefix is the least-privilege boundary. No static AWS keys
anywhere — the SDK's default chain hits IMDSv2 (enforced on the instance).

## Adding a new secret

1. Put it in SM under the prefix: name is lower-kebab-case, e.g.
   `/terrarium/prod/stripe-secret-key`.
2. If it's **boot config for the control plane itself**: add a row to
   `AWS_BOOT_SECRETS` in `src/secrets/boot.ts` (`"stripe-secret-key": "STRIPE_SECRET_KEY"`),
   and list the env var in the `/config-check` key table in `server.ts`.
3. If it's an **integration token**: nothing to add — integrations reference
   it by name via `tokenEnv`, resolved at proxy time.
4. Redeploy the control-plane container (boot config is read once at boot;
   proxy-time secrets need no redeploy).

Naming convention: `<vendor>-<purpose>[-<qualifier>]`, lower-kebab-case —
`logto-m2m-app-secret`, `github-app-private-key`, `cloudflare-api-token`.

Boot config also includes the control-plane database: `/terrarium/prod/
database-url` is the full `postgres://…` URL for the RDS `control_plane` DB
(built from the RDS-managed master secret, password URL-encoded), mapped to
`DATABASE_URL` in `AWS_BOOT_SECRETS`. When unset, the control plane falls back
to embedded PGlite — local dev is unchanged. See DB-SPIKE.md.

## Verifying

`GET /config-check` (ungated, same trust level as `/health`) returns — names
only, never values — which config keys are set and from which source
(`aws-secrets-manager` | `env` | `unset`), plus which boot fetches failed.

## How Infisical or Vault slots in

They are a third implementation of the same two seams, nothing else changes:

- **Proxy-time**: `SecretsProvider.infisicalLayer({ projectId, env })` /
  `vaultLayer({ mount })` next to `awsLayer` in `src/integrations/secrets.ts`,
  same shape — `resolve(name) → Effect<Option<string>>` with its own cache.
  Selection grows a case in `SecretsProvider.layerFromEnv()`
  (`SECRETS_PROVIDER=infisical|vault`).
- **Boot**: a `loadBootSecrets` variant keyed off the same
  `SECRETS_PROVIDER` switch, fetching from the Infisical/Vault path that
  mirrors `/terrarium/prod/`.
- **Identity**: on AWS, Infisical/Vault should consume the same instance
  profile (Infisical AWS IAM auth, Vault AWS auth method) so no new static
  credential is introduced — same federated-identity-over-keys rule.

The provider interface stays exactly the four verbs from
`docs/providers.md`; only this package knows which backend is active.
