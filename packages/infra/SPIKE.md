# Terrarium Infrastructure Spike

Production-shaped AWS infrastructure for the Terrarium auth server (Logto) +
control plane, deployed with [Alchemy](https://alchemy.run) (IaE).

## What was provisioned

### AWS (account `412215357683`, region `us-east-1`, profile `givefront-dev`)

| Resource | ID | Notes |
|----------|----|-------|
| VPC | `vpc-0f516d6081d45346b` | 2 AZs, public + private subnets, no NAT |
| EC2 instance | `i-0bdb85c26fc394cc7` | Ubuntu 24.04 LTS, t3.small, 30GB gp3 |
| Elastic IP | `107.23.2.162` (`eipalloc-0c073e564d8525909`) | Stable DNS target |
| EC2 security group | `sg-06440839a8409a0ba` | Ports 22 (SSH), 80 (HTTP), 443 (HTTPS) |
| RDS security group | `sg-086d5d8a73ffa0f29` | Port 5432 from EC2 SG only |
| RDS Postgres 16 | `terrariuminfra-postgres-live-aidan-a2whqelgnf35juwv` | db.t4g.micro, 20GB gp3, private |
| RDS endpoint | `terrariuminfra-postgres-live-aidan-a2whqelgnf35juwv.cctumyw2o6uz.us-east-1.rds.amazonaws.com` | `publiclyAccessible: false` |
| RDS master secret | `arn:aws:secretsmanager:us-east-1:412215357683:secret:rds!db-6f5a2477-69a7-47b1-beae-ef2ebf072818-5VuAW8` | Managed by RDS in Secrets Manager |
| SSH key pair | `TerrariumInfra-SshKey-live-aidan-erl4izfsi5wjh2n3` | ed25519, private key in `.secrets/terrarium-key.pem` |
| DB subnet group | `terrariuminfra-dbsubnets-live-aidan-lntcj47urmwnzrkq` | Private subnets only |

**Databases on the RDS instance:**
- `logto` — initial database (created by RDS `dbName` prop)
- `control_plane` — created by bootstrap script via psql (RDS only creates one initial DB)

### Cloudflare (account `7bbaa8f97d6ababf1a5e29eb79491ce3`)

| Record | Type | Name | Content | Proxied |
|--------|------|------|---------|---------|
| `d3576ab481fa327af5825e89abb883c6` | A | `auth.vibevarium.com` | `107.23.2.162` | No (grey cloud) |
| `1dafcb3d17e03e1c6fdb1eb4ec84a82b` | A | `platform.vibevarium.com` | `107.23.2.162` | No (grey cloud) |

DNS-only (grey cloud) so Caddy on the box terminates TLS via Let's Encrypt HTTP-01.

**Note on Cloudflare tokens:** The original `CLOUDFLARE_API_TOKEN` in `.env` is
Workers-scoped (no DNS permissions). A separate DNS-capable token was created
via the Cloudflare API for the `vibevarium.com` zone. For future alchemy
deploys that include DNS records, set `CLOUDFLARE_API_TOKEN` to a token with
`Zone.DNS:Edit` on the target zone.

### On the EC2 box

- Docker + docker-compose plugin
- `/opt/terrarium/compose/` — Caddy, Logto, control-plane services
- `/opt/terrarium/compose/.env` — domain + DB credentials (not committed)
- `/opt/terrarium/compose/control-plane/` — workspace source for Docker build

**Services (docker compose):**
- **Caddy** (`caddy:2-alpine`) — reverse proxy, auto-TLS via Let's Encrypt
- **Logto** (`ghcr.io/logto-io/logto:latest`) — OIDC auth server, port 3001
- **Control plane** (built from `packages/control-plane/Dockerfile`) — Node 22 + tsx, port 4100, PGlite on a Docker volume

## Verification

### Logto OIDC discovery document

```
$ curl -s https://auth.vibevarium.com/oidc/.well-known/openid-configuration | jq '{issuer, authorization_endpoint, token_endpoint, jwks_uri}'
{
  "issuer": "https://auth.vibevarium.com/oidc",
  "authorization_endpoint": "https://auth.vibevarium.com/oidc/auth",
  "token_endpoint": "https://auth.vibevarium.com/oidc/token",
  "jwks_uri": "https://auth.vibevarium.com/oidc/jwks"
}
```

Full discovery doc includes: `grant_types_supported` (authorization_code,
client_credentials, refresh_token, device_code, token-exchange),
`code_challenge_methods_supported: ["S256"]`, `id_token_signing_alg_values_supported: ["ES384"]`.

JWKS: `curl -s https://auth.vibevarium.com/oidc/jwks` returns 1 key.

### Control plane health

```
$ curl -s https://platform.vibevarium.com/health
ok

$ curl -s https://platform.vibevarium.com/directory | jq '.'
{ "apps": [], "tools": [] }
```

## Deploy / Destroy commands

### Prerequisites

```sh
cd packages/infra

# Source Cloudflare credentials (token + account ID)
set -a && source ../../.env && set +a

# AWS profile
export AWS_PROFILE=givefront-dev
export AWS_REGION=us-east-1

# Domain config
export TERRARIUM_DOMAIN=vibevarium.com
export CLOUDFLARE_ZONE_ID=c6ae3b555628f3c6c0fb3883c479dcc4

# Optional: restrict SSH (default 0.0.0.0/0)
# export TERRARIUM_SSH_CIDR=203.0.113.10/32
```

### Deploy (AWS + DNS)

```sh
# First time: configure alchemy profile
pnpm exec alchemy profile edit --add AWS --method sso --set ssoProfile=givefront-dev --no-input
pnpm exec alchemy profile edit --add Cloudflare --method stored --set accountId=env:CLOUDFLARE_ACCOUNT_ID --set apiToken=env:CLOUDFLARE_API_TOKEN --no-input

# Deploy everything
pnpm exec alchemy deploy --config ./src/main.ts --yes

# If DNS records were created manually, adopt them:
pnpm exec alchemy deploy --config ./src/main.ts --yes --adopt
```

### Bootstrap the box

```sh
bash scripts/deploy.sh
```

This: associates the EIP, waits for SSH, installs Docker, creates the
`control_plane` database, copies compose files + workspace, and runs
`docker compose up`.

### Destroy

```sh
pnpm exec alchemy destroy --config ./src/main.ts --yes
```

Note: RDS takes a final snapshot on destroy (`skipFinalSnapshot: false`).

## Environment variables the control plane needs

| Var | Value | Notes |
|-----|-------|-------|
| `PORT` | `4100` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address (must be 0.0.0.0 in Docker) |
| `DATABASE_PATH` | `/data/pglite` | PGlite data directory (Docker volume) |
| `TERRARIUM_ISSUER` | `https://auth.${DOMAIN}` | OIDC issuer URL |
| `DISCOVERY_INTERVAL_MS` | `30000` | Discovery poll interval |

**Future (when PGlite → RDS swap lands):**
- `DATABASE_URL=postgres://postgres:${DB_PASSWORD}@${DB_HOST}:5432/control_plane?sslmode=no-verify`

## Known gaps

1. **PGlite vs RDS**: The control plane runs PGlite on a Docker volume
   (`control_plane_data`). The RDS `control_plane` database is provisioned
   but unused. Swapping PGlite → `node-pg` via drizzle is a follow-up — the
   `Database.layer()` seam in `store/database.ts` is where to wire it.

2. **Secrets in compose `.env`**: DB credentials are written to
   `/opt/terrarium/compose/.env` on the box. This is fine for a spike but
   should move to Docker secrets or AWS Secrets Manager injection for
   production.

3. **Logto seed idempotency**: The `npm run cli db seed` runs on every
   container start. Logto's seed is idempotent (no-op when schema is current),
   but it's wrapped in `|| true` to be safe. The seed runs BEFORE the server
   starts, so a failed seed won't block startup.

4. **No EIPAssociation in alchemy**: The Elastic IP association is done by the
   deploy script (`aws ec2 associate-address`), not by alchemy. Alchemy
   beta.87 has no `EIPAssociation` resource.

5. **Cloudflare DNS token**: The original `.env` token is Workers-scoped. DNS
   records were created with a separate token. For `alchemy deploy` to manage
   DNS, the token needs `Zone.DNS:Edit` on the target zone.

6. **EBS volume**: The default 8GB root volume was too small for Docker builds.
   Resized to 30GB via `aws ec2 modify-volume` + `growpart` + `resize2fs`.
   Future deploys should set the volume size in the EC2 instance props.

7. **SSH access**: Currently `0.0.0.0/0`. Set `TERRARIUM_SSH_CIDR` to restrict.

## Manual Logto admin setup (STOP here — user's step)

The Logto admin console is at `https://auth.vibevarium.com/console`. The
first-admin signup flow:

1. Open `https://auth.vibevarium.com/console` in a browser
2. Logto will prompt to create the first admin account
3. Create the admin user (email + password)
4. The admin console lets you: create applications (M2M, SPA, traditional web),
   register API resources, configure SSO connectors, manage users

The platform's OIDC issuer is `https://auth.vibevarium.com/oidc`. Apps verify
tokens against `https://auth.vibevarium.com/oidc/jwks`.

## State

Alchemy state is local file-based (`.alchemy/` in the infra package directory).
The `.alchemy/` directory is gitignored. State includes the SSH private key
(Redacted, stored encrypted at rest by alchemy's local state codec).
