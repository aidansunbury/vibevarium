# Deployment Topologies — control plane and apps across AWS and Cloudflare

The control plane runs on **AWS today** and should be deployable to
**Cloudflare** as a first-class alternative. Apps can target either cloud.
Because the demo runs on **AWS credits**, **AWS is the default topology**;
the Cloudflare topologies exist to prove the platform is genuinely
multi-cloud — deployable across AWS and Cloudflare even though most real
usage would pick Cloudflare for apps. This doc is the design for that
flexibility — scoped to a proof of concept that must *scale to* production,
not pay for it now. Builds on [provisioning.md](./provisioning.md),
[stack.md](./stack.md), [providers.md](./providers.md); companion to
[planetscale.md](./planetscale.md).

## 1. Current state (what's actually deployed)

**Control plane — AWS** ([packages/infra](../packages/infra/src/aws.ts)):

- One VPC (2 AZs, no NAT). One **EC2** (Ubuntu 24.04, `t3.medium`) runs Docker;
  `docker-compose` ([packages/infra/compose](../packages/infra/compose/docker-compose.yml))
  runs the control plane behind **Caddy** (TLS + reverse proxy).
- One **RDS Postgres** (`db.t4g.micro`, private subnets, reachable only from
  the EC2 security group) hosting `control_plane` (and `logto`). The control
  plane reaches it via `DATABASE_URL` from AWS Secrets Manager
  (`/terrarium/prod/database-url`, resolved through the EC2 instance profile).
- **So: EC2 + Docker + Caddy + RDS.** No ECS, no EKS — plain EC2.

**Apps — Cloudflare Workers** by default, each with its own **D1**
([template-cloudflare](../packages/template-cloudflare/alchemy.run.ts)),
deployed by the scaffold via Alchemy
([scaffold/cloudflare-deployer.ts](../packages/control-plane/src/scaffold/cloudflare-deployer.ts)).

## 2. The two axes

Control-plane topology and app/database topology are **independent axes**.
They compose freely because the only hard requirement between them is
reachability and the contracts each layer exposes.

| Layer | Options | Default | Contract |
| --- | --- | --- | --- |
| **Control plane compute** | AWS EC2 (current) · Cloudflare Workers (target) | AWS for now | HTTPS control API + gateway |
| **Control plane database** | AWS RDS (current) · PlanetScale Postgres (target) | RDS for now | `DATABASE_URL` (Postgres wire) |
| **App compute** | Cloudflare Workers · AWS Lambda (validated, unimplemented) | Cloudflare Workers | HTTPS endpoint that verifies OIDC tokens |
| **App database** | D1 · PlanetScale Postgres (via Hyperdrive) | D1 | a database binding |

## 3. Control-plane compute: EC2 → Workers

The control plane is an Effect HTTP server
([src/main.ts](../packages/control-plane/src/main.ts),
[src/server.ts](../packages/control-plane/src/server.ts)). The only
target-specific assumptions are the ones every long-running Node process makes;
porting to Workers means confronting four real seams:

1. **Runtime/entry.** The Node entry becomes a Worker `fetch` handler. The
   Effect HTTP layer is already abstract enough that this is an adapter, not a
   rewrite.
2. **Process spawn for app deploys.** Today
   [scaffold/cloudflare-deployer.ts](../packages/control-plane/src/scaffold/cloudflare-deployer.ts)
   shells out to the `alchemy` CLI to deploy each app. **A Worker cannot spawn
   processes.** This is the single biggest blocker. The resolution path is the
   Cloudflare REST API (create Worker / D1 / Hyperdrive directly) instead of
   shelling out — i.e. the deployer stops being a CLI wrapper and becomes an
   API client. This work is *also* what unblocks per-app PlanetScale/Hyperdrive
   provisioning, so it pays twice.
3. **Secrets.** `SECRETS_PROVIDER=aws` (Secrets Manager via instance profile)
   has a `SecretsProvider` seam already; a Workers target resolves config from
   Worker secrets/env instead. The seam is the point.
4. **The local-dev default is unchanged**: PGlite + Node.

**AWS stays the default for the demo.** There is no reason to move working
infrastructure off AWS credits. The Workers target is built to prove the
platform is genuinely target-agnostic — the same reason the wizard offers
target *choices* at all.

## 4. Control-plane database: RDS → PlanetScale

The store layer is already driver-pluggable
([src/store/database.ts](../packages/control-plane/src/store/database.ts)):
`DATABASE_URL` set → real Postgres via `postgres.js`; otherwise embedded
PGlite. RDS today is just a `DATABASE_URL`. **PlanetScale Postgres is therefore
a connection-string change, not a port.**

The real design decision is the **pairing between control-plane compute and
control-plane database**, because a Workers-hosted control plane cannot hold a
long-lived TCP connection to RDS across invocations:

| | **RDS** | **PlanetScale** |
| --- | --- | --- |
| **EC2 control plane** | ✅ Current, private VPC, no public exposure | ✅ Fine (public endpoint + TLS) |
| **Workers control plane** | ⚠️ Needs Hyperdrive in front (RDS must be reachable; private VPC needs extra plumbing) | ✅ Natural — Hyperdrive + PlanetScale is the first-party pairing |

So the two **coherent control-plane topologies** are:

- **AWS:** EC2 + RDS (current). Keep it.
- **Cloudflare:** Workers + PlanetScale-via-Hyperdrive. This is the clean
  Cloudflare-native pairing and doubles as the reference implementation of the
  same Hyperdrive path apps use.

A Workers + RDS pairing is *possible* but is the awkward middle — don't make it
a blessed topology for the demo.

## 5. Apps target both AWS and Cloudflare

Apps deploy to **either** cloud. The platform default is AWS (credits); the
Cloudflare targets prove apps are portable.

**Why Lambda for AWS apps, not ECS/Fargate.** The app cost story *is*
scale-to-zero: most vibe-coded internal apps sit at near-zero traffic, so an
idle app should cost ~nothing. Fargate is always-on (~$30–40/mo per service
floor) and kills that story. Lambda + a Function URL gives "idle app costs
~nothing" and is the honest AWS analog of a Worker. **ECS is a platform
scale-up path, not an app target** (§3).

- **AWS app = Lambda + Function URL**, stateless per-request compute with all
  state externalized — the same shape as the Worker template
  ([template-cloudflare](../packages/template-cloudflare/alchemy.run.ts)).
- **AWS app database = RDS.** See §5a.
- **Cloudflare app = Worker + D1** (default) or **Worker + PlanetScale via
  Hyperdrive** (Postgres) — see [planetscale.md](./planetscale.md).

**Caveats (honest):** a Lambda app has **no Hyperdrive** (Cloudflare-only), so
it manages its own Postgres connections — fine at app scale. And cold starts
matter more for user-facing apps, part of why Workers would be the *usage*
default even though AWS is the *credits* default.

### 5a. RDS per app (the AWS-Postgres option)

For "this app wants Postgres and wants AWS": provision **one RDS instance per
app** — deliberately simple, the strongest isolation story, and on credits the
~$15/mo/instance floor is the *point* (it demos "real AWS" and previews share
nothing with prod). Database-per-app on a *shared* instance, and
schema-per-app, are documented **consolidation levers for scale**, not the demo
path.

- **Per-app isolation on RDS works, but it's plumbing, not a binding.**
  Postgres roles scope a user to one database fine (`CREATE USER app …;
  GRANT CONNECT ON DATABASE app …`). The friction is everything around it:
  the credential must reach the Lambda (per-app Secrets Manager entries + env
  vars you wire yourself), the Lambda must be VPC-attached to reach RDS
  (cold-start + NAT/subnet plumbing) or the RDS must be public (don't), and
  **RDS IAM database authentication is instance-scoped, not database-scoped** —
  IAM auth removes the stored password but per-database scoping still lives in
  Postgres grants, not in IAM. Contrast with Cloudflare, where a Hyperdrive
  config **is** the scoped credential, bound to one Worker and able to reach
  exactly one database by construction.
- **Preview = a separate RDS instance** (instance-per-app, so a preview shares
  no compute/connection-pool/blast-radius with prod). This is the clean-isolation
  version; it's also why the per-app-instance model costs real money and why
  consolidation is a scale lever.

### 5b. No cross-cloud database bindings

Each app database is provisioned in the same cloud as the app's compute:
**AWS app → RDS, Cloudflare app → D1 or PlanetScale.** There is no supported
cross-cloud database binding (e.g. an AWS app on PlanetScale). Hyperdrive is
Workers-only, so it never appears on the AWS side at all.

## 6. Blessed topologies (demo scope)

Encode exactly these as the supported combinations — enough to prove
agnosticism without a combinatorial matrix to maintain. **#1 is the
credits-optimized default; #4 is the portability headline.**

| # | Control plane | CP database | App compute | App database | Story |
| --- | --- | --- | --- | --- | --- |
| 1 | **AWS EC2** | **RDS** | **Lambda** | **RDS per app** | **Default (credits).** Postgres apps on AWS. |
| 2 | AWS EC2 | RDS | Workers | D1 | Cheap apps, any app-compute cloud |
| 3 | AWS EC2 | RDS | Workers | PlanetScale via Hyperdrive | Postgres apps on Cloudflare ([planetscale.md](./planetscale.md)) |
| 4 | **Workers** | **PlanetScale via Hyperdrive** | Workers | D1 / PlanetScale | **Portability proof** — platform + apps entirely off AWS |

Topology 1 is the default because the demo runs on AWS credits. Topology 4 is
the headline that the platform isn't married to AWS. Topologies 2–3 show the
app compute/database layers compose independently of where the control plane
lives. All four are follow-ups on top of the existing AWS-EC2+RDS platform and
Workers+D1 app path; none blocks another.

## 7. What this deliberately does not build

- **No ECS/EKS migration for the platform.** EC2 + Docker is fine for a demo
  and scales far enough. Container orchestration (ECS Fargate) is a platform
  *scale-up* path, not a PoC need — and it is never an app target (Fargate's
  always-on floor kills the app cost story).
- **No shared-RDS / schema-per-app for apps** — consolidation levers, deferred.
- **No AWS app target with Hyperdrive** (contradiction — Hyperdrive is
  Workers-only).
- **No control-plane HA / multi-region.** Single control-plane instance is
  acceptable for a demo; the directory already serves last-known-good so a
  control-plane blip doesn't kill running apps
  ([overview.md](./overview.md) — fault isolation).
