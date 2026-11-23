# Deployment Topologies — control plane and apps across AWS and Cloudflare

The control plane runs on **AWS today** and should be deployable to
**Cloudflare** as a first-class alternative. Apps default to **Cloudflare
Workers** regardless. This doc is the design for that flexibility — scoped to a
proof of concept that must *scale to* production, not pay for it now. Builds on
[provisioning.md](./provisioning.md), [stack.md](./stack.md),
[providers.md](./providers.md); companion to [planetscale.md](./planetscale.md).

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

## 5. App database and the mixed-target reality

Apps default to Workers + D1. A `planetscale-hyperdrive` app is Workers +
PlanetScale-through-Hyperdrive ([planetscale.md](./planetscale.md)).

For the *theoretical* "AWS app pointing at a configured Postgres database":
a PlanetScale database is reachable from anywhere over a normal connection
string, so **an AWS-hosted app can use PlanetScale** — just without Hyperdrive
(a Lambda uses a standard Postgres client and manages its own connections).
Hyperdrive is the Cloudflare-specific accelerator, not a hard dependency. This
keeps the claim honest: "apps can point at any configured Postgres" holds, with
the caveat that the Hyperdrive binding is Workers-only.

## 6. Recommended blessed topologies (demo scope)

Encode exactly these as the supported combinations — enough to prove
agnosticism without a combinatorial matrix to maintain:

| # | Control plane | CP database | App compute | App database | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | AWS EC2 | RDS | Workers | D1 | **Current default** |
| 2 | AWS EC2 | RDS | Workers | PlanetScale via Hyperdrive | Near-term: fill the provisioning stub ([planetscale.md](./planetscale.md) §3) |
| 3 | Cloudflare Workers | PlanetScale via Hyperdrive | Workers | D1 / PlanetScale | Target: proves control-plane portability |

Topology 3 is the one that demonstrates the platform isn't married to AWS.
Topology 2 is the one that demonstrates Postgres-backed apps. Both are
follow-ups; neither blocks the other.

## 7. What this deliberately does not build

- **No ECS/EKS migration.** EC2 + Docker is fine for a demo and scales far
  enough. Container orchestration is a production concern, not a PoC one.
- **No Workers + RDS blessed topology** (the awkward middle).
- **No AWS app target with Hyperdrive** (contradiction — Hyperdrive is
  Workers-only).
- **No control-plane HA / multi-region.** Single control-plane instance is
  acceptable for a demo; the directory already serves last-known-good so a
  control-plane blip doesn't kill running apps
  ([overview.md](./overview.md) — fault isolation).
