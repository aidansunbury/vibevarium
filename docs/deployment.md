# Production deployment

The production stack is `VibevariumEcs` in the `live_aidan` stage:

- **API + auth:** ECS Fargate behind an ALB, with PostgreSQL on RDS. Casdoor and
  the control plane use separate logical databases on the same RDS instance.
- **GUI:** the Vite SPA built by `AWS.Website.Vite`, uploaded to a private S3
  bucket and served through CloudFront. SPA fallback is enabled for client-side
  routes such as `/connections`.
- **DNS + certificates:** ACM, with validation and alias records published to
  the existing Cloudflare zone through `Cloudflare.DNS.Adapter`.
- **State:** Alchemy's shared `AWS.state()` store, so local and CI deploys use
  the same state.

## One-time setup

Bootstrap the remote state store:

```bash
pnpm --dir packages/infra exec alchemy state bootstrap \
  --config ./src/main-ecs.ts --backend aws
```

Set the domain, zone, certificate, secret ARN, and Secrets Manager policy
variables required by `packages/infra/src/main-ecs.ts`, then provision the
GitHub OIDC role, scoped Cloudflare token, and Actions configuration:

```bash
pnpm --dir packages/infra deploy:ci --stage live_aidan --yes
```

The CI stack must be run with an AWS identity allowed to create IAM roles and
an account-scoped Cloudflare credential allowed to create API tokens. It uses
the current `gh` login to write the repository variables and the
`CLOUDFLARE_API_TOKEN` Actions secret.

## Durable GUI session rollout

Provision the stable session key **before** deploying an auth layer that requires it.
Generate it once; do not regenerate it during later deploys:

```bash
aws secretsmanager create-secret \
  --name /vibevarium/prod/SESSION_ENCRYPTION_KEY \
  --secret-string "$(openssl rand -base64 48)"
```

The existing task role reads this through `AWS_BOOT_SECRETS`; no task-definition
secret ARN is needed. The automatic deployment workflow performs the same
creation idempotently and never rotates an existing key. Boot creates the
`sessions` and `session_transactions`
tables idempotently. Existing in-memory sessions cannot be migrated, so the
first deployment with durable sessions causes one final login. Later ECS
restarts preserve both authenticated sessions and in-progress PKCE logins.

GUI logins have an independent absolute lifetime, configured by
`GUI_SESSION_TTL_MS` (default `604800000`, seven days). The session cookie uses
the same lifetime. `GUI_SESSION_REFRESH_SKEW_MS` controls early access-token
refresh (default `60000`). Changing the encryption key invalidates existing
cookies and encrypted rows; plan a key-rotation migration instead of replacing
it casually.

Verify login, refresh, logout, and restart continuity after rollout. To revoke
sessions manually, an operator with database access can run:

```sql
DELETE FROM sessions WHERE user_sub = 'the-oidc-subject'; -- one user
DELETE FROM sessions;                                    -- all users
DELETE FROM session_transactions;                        -- pending logins
```

## Deploy manually

```bash
pnpm --dir packages/infra deploy --stage live_aidan --yes
node --experimental-strip-types packages/infra/scripts/bootstrap-database.ts
bash packages/infra/scripts/casdoor-bootstrap.sh
node --experimental-strip-types packages/infra/scripts/verify-production.ts
```

Set `DEPLOYED_GIT_SHA=$(git rev-parse HEAD)` before deployment so
`/config-check` reports the running commit.

## Automatic deploys

`.github/workflows/deploy-production.yml` runs on pushes to `main` and through
**Run workflow**. It validates the repo, assumes the AWS role through GitHub
OIDC, checks provider credentials, deploys the ECS/RDS/CloudFront stack,
bootstraps Casdoor idempotently, and verifies the public API, auth, MCP
metadata, required OAuth configuration, and GUI deep links.

The recurring workflow does **not** use `--adopt`. Adoption is only for the
one-time migration of existing resources into remote state.
