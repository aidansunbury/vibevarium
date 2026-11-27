# Setting up your own vibevarium

vibevarium is **self-hosted** — there is no hosted service to sign up for. This
guide takes you from a fork to a running instance: a control plane on your own
infrastructure, an auth server you own, and your first app grown end-to-end.

There are three ways to run it, depending on what you're doing:

| Path | What it's for | What you need |
|---|---|---|
| **Local dev** | Hacking on vibevarium itself, trying the flows | Just this repo + Node |
| **AWS production** | A real instance for your company | AWS + Cloudflare + GitHub + a domain |
| **Cloudflare-hosted control plane** | Everything on the edge, no EC2 | Cloudflare + GitHub + a domain |

If you're evaluating, start with **local dev** — it's zero-infrastructure and
proves every flow (auth, scaffold, connections, the proxy) with emulators.

---

## Path 1 — Local dev

Everything runs on your machine with embedded databases and a dev OIDC issuer.
No cloud accounts needed.

### Prerequisites

- Node.js ≥ 22 (the repo uses `--experimental-strip-types`)
- pnpm 10 (`npm i -g pnpm` or `mise use pnpm@10.28.2`)

### Run it

```bash
git clone https://github.com/<you>/vibevarium.git
cd vibevarium
pnpm install
pnpm --dir packages/control-plane dev
```

That boots the control plane with:

- **PGlite** (embedded Postgres) for state — zero setup, data in `.data/`
- A **dev OIDC issuer** on `127.0.0.1:4010` that mints real RS256 JWTs
- A **fake OAuth provider** so you can run the connections flow without
  touching GitHub/Linear

The GUI is at `http://127.0.0.1:4100` (or the port it prints). Sign in with a
dev token from `http://127.0.0.1:4010/dev/token?sub=you&name=You`.

### Prove the flows

```bash
# The meta-OAuth flow, end-to-end against the fake provider:
pnpm --dir packages/control-plane connections:demo

# The integration proxy (company-shared credentials):
pnpm --dir packages/control-plane proxy:demo
```

When configuring the real GUI OIDC login locally, also set a stable
`SESSION_ENCRYPTION_KEY` in the repo-root `.env` (generate one with
`openssl rand -base64 48`). It encrypts database-backed GUI credentials and must
stay unchanged between restarts. Auth-disabled local development does not need it.

To test real GitHub/Linear connections locally, create OAuth apps with callback
`http://127.0.0.1:4100/connections/callback` and drop the credentials in a
repo-root `.env` (`GITHUB_OAUTH_CLIENT_ID=…` etc.). Providers are enabled by
their entries in `packages/control-plane/src/config/connections.config.ts` (see
[customization.md](./customization.md#connections)).

### Parallel development with T3 Code

The checked-in `t3.json` defaults new threads to isolated worktrees and defines
a **Setup Worktree** action. Import the repository actions once in **Settings →
Projects → Actions** if they are not already configured for your checkout. The
setup action waits for completion before the agent starts and runs
`scripts/setup-worktree.sh`, which:

- links the main checkout's root `.env` into the worktree when one exists,
  without overwriting a worktree-specific file;
- runs `pnpm install --frozen-lockfile`; and
- builds the control-plane GUI, whose `dist/` output is not tracked by Git.

Add future code generation, migrations, or other initialization to that script
so every new worktree gets the same setup. Each worktree has its own
`node_modules` and default PGlite data under `.data/`.

Ports are still shared by every checkout on the machine. To run multiple dev
servers concurrently, give each one a different set of ports, for example:

```bash
PORT=4110 OIDC_PORT=4111 APP_PORT=4310 pnpm --dir packages/control-plane dev
```

---

## Path 2 — AWS production

The reference deployment: the control plane and Casdoor on ECS Fargate,
Postgres on RDS, the GUI on S3 + CloudFront, secrets in AWS Secrets Manager,
and DNS + ACM validation in Cloudflare. See [deployment.md](./deployment.md)
for the current stack, manual commands, and GitHub Actions deployment.

### What you'll need

| Thing | Why |
|---|---|
| An **AWS account** + profile (`aws configure sso`) | EC2, RDS, Secrets Manager, IAM |
| A **Cloudflare account** + zone for your domain | DNS + per-app Workers |
| A **GitHub org** + a GitHub App | App repos are created here |
| A **domain** you can point at the box | e.g. `internal.yourcompany.com` |

### 1. Configure

```bash
cp .env.example .env   # then edit
```

The knobs that matter:

```bash
TERRARIUM_DOMAIN=internal.yourcompany.com   # one knob re-domains everything
CLOUDFLARE_ZONE_ID=…                         # from the Cloudflare dashboard
AWS_PROFILE=your-sso-profile
```

### 2. Deploy the infrastructure

```bash
source .env
pnpm --dir packages/infra deploy --stage live_aidan --yes
bash packages/infra/scripts/verify-production.sh
```

The ECS stack builds and publishes the control-plane image, updates the ECS
services and ALB, builds and publishes the GUI to S3 + CloudFront, and manages
ACM validation and DNS records through the Cloudflare adapter. Verify with:

```bash
curl https://auth.$TERRARIUM_DOMAIN/.well-known/openid-configuration
curl https://api.$TERRARIUM_DOMAIN/health
curl https://api.$TERRARIUM_DOMAIN/config-check   # which config came from SM (names only)
curl https://platform.$TERRARIUM_DOMAIN/connections
```

### 3. Fill the secrets

Everything secret lives in **AWS Secrets Manager** under
`/vibevarium/prod/` — never in env files on the box. The control plane reads
them at boot via its instance profile (no static AWS keys anywhere). The full
list, and how to add your own, is in [customization.md](./customization.md#secrets).

### 4. Grow your first app

Sign in to `https://platform.$TERRARIUM_DOMAIN`, hit **scaffold** (or
`vibevarium grow my-app` from the CLI), and a few minutes later the app is
live: repo in your GitHub org, Cloudflare Worker + D1, its own hostname, its
own OIDC client, discovered by the gateway automatically.

---

## Path 3 — Cloudflare-hosted control plane

For a fully edge-native instance: the control plane itself as a Cloudflare
Worker, no EC2 at all.

> **Status: experimental.** The control plane is a Node + Postgres app and the
> EC2 path is the proven one. The Cloudflare path works for the stateless
> routes (gateway, proxy) but the store needs either a Postgres-compatible
> edge database or Durable Objects. Treat this as the direction, not the
> default.

```bash
cd packages/control-plane
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_ZONE_ID=… \
  pnpm router:deploy    # the router worker
# then the control-plane worker itself:
alchemy deploy --config src/router/alchemy.run.ts
```

The pieces that move to Cloudflare: the router (wildcard hostname → app),
per-app Workers (unchanged — they were always Workers), and eventually the
control plane's stateless tier. Auth still runs wherever your OIDC issuer
lives (Casdoor/WorkOS/your SSO).

If you want this path today, start from `src/router/alchemy.run.ts` and expect
to port the store — and open an issue; this is an active direction.

---

## After setup

- **Customize**: [customization.md](./customization.md) — theming, auth
  providers, connections, secrets, the domain knob.
- **The CLI**: `vibevarium` — `grow`, `ls`, and it composes every app's own
  CLI so humans and agents share one interface.
- **Connections**: connect GitHub/Linear once, vend per-app tokens through the
  credential proxy, revoke with a cascade.

## Getting help

- Issues: <https://github.com/aidansunbury/vibevarium/issues>
- The control plane's `/config-check` endpoint at `api.$TERRARIUM_DOMAIN` shows
  which config resolved and from where (names only, never values) — the first
  place to look when something's "unset".
