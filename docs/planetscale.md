# PlanetScale — the real-Postgres tier for Cloudflare apps

How PlanetScale fits Terrarium: the Postgres option for **Cloudflare apps**
(reached via Hyperdrive). For **AWS apps**, the Postgres option is **RDS per
app** instead — see
[deployment-topologies.md](./deployment-topologies.md) §5a. Builds on
[provisioning.md](./provisioning.md) (capability config), [stack.md](./stack.md)
(templates encode decisions), and [providers.md](./providers.md) (everything is
a provider).

This doc is deliberately **demo-scoped**: the current build is a proof of
concept. Every choice here is one that *scales to production* without paying
for production now.

## 1. The terminology trap

A PlanetScale **"database" is not a Postgres database** — it is a *project*: an
isolated cluster with its own compute, storage, replicas, and connection
strings. There is no shared server where you run `CREATE DATABASE foo` per app.
This matters because the multi-tenant design options are:

| Approach | What it is | Verdict |
| --- | --- | --- |
| **One PlanetScale database per app** | Each app gets its own project/cluster (`PS-5` single node, $5/mo) | ✅ **The demo choice.** Postgres analog of `{name}-data` D1 |
| Postgres **schemas** in one shared database | `app_expenses.users`, `app_tickets.users` behind one connection string | ⏸ A *cost optimization* for hundreds of apps. **Skip for the demo** |
| Table prefixing in one shared database | `expenses_users`, … | ❌ Uglier, same caveats as schemas |
| Many Postgres DBs on one cluster | `CREATE DATABASE` per app on one PlanetScale cluster | ❌ Off the beaten path — PlanetScale's tooling is oriented around database=project |

**Decision: database-per-app.** It is what real platforms do, it matches the
existing D1 model one-for-one, and it demos the story that matters: *same
template, same code, one dropdown decides SQLite vs. Postgres.*

> The shared-DB-with-schemas design is a real pattern, but it exists to solve a
> **cost** problem ($5+/mo × hundreds of Postgres apps adds up). That is a
> scale problem, not a demo problem. Nothing in this design *precludes* it —
> the `DatabaseProvider` seam doesn't care whether a "database" is a project or
> a schema — it is simply not built now.

## 2. Why PlanetScale (and not Neon)

The credible alternative for Postgres-backed previews is Neon, which has
genuinely better **copy-on-write** branching (instant, zero-copy). PlanetScale
wins for Terrarium anyway:

- **First-party Cloudflare partnership** (announced Sept 2025, deepened 2026):
  create PlanetScale databases from the Cloudflare dashboard, **billed through
  your Cloudflare account**, auto-created Hyperdrive configs with one-click
  credential rotation. One vendor relationship for the whole stack.
- **Boring-production credibility** — PlanetScale Metal on locally-attached
  NVMe is the "scale to real traffic" story. Terrarium apps are small, but the
  platform promise is that a Postgres-backed app can grow up without
  re-architecting.
- Branching is *good enough* for previews (see §4) and fully API/CLI
  automatable.

## 3. Provisioning a Postgres-backed app

Today `planetscale-hyperdrive` is a **validated-but-stubbed** database option:
the capability config requires `PLANETSCALE_HOST/USERNAME/PASSWORD/DATABASE` +
`CLOUDFLARE_HYPERDRIVE_ID` ([src/config](../packages/control-plane/src/config/index.ts)),
and the provisioning pipeline has an `Attach PlanetScale Hyperdrive` step that
currently just marks `"Hyperdrive bound (config)"` without doing anything
([src/provisioning](../packages/control-plane/src/provisioning/index.ts)).

Making it real means replacing that stub with three concrete steps:

1. **Create the app's database.** `pscale database create <app-name> --cluster-size PS-5`
   (or the REST API `POST /organizations/{org}/databases`) using a service
   token. This is the Postgres analog of `{name}-data` D1. Record the app ↔
   database lineage in the control-plane store so teardown works.
2. **Create a Hyperdrive config** pointing at the new database's host (Alchemy
   supports Hyperdrive resources) and bind it to the app's Worker. App code
   uses a plain Postgres driver (`pg` / postgres.js) or Drizzle — which the
   template already ships — against the Hyperdrive binding. **Do not** use the
   `@planetscale/database` serverless driver; that is for the Vitess product.
3. **Run migrations** against the database (the template's `./migrations`,
   same contract as D1).

The app-facing contract is **identical** to D1: the app declares "I need a
database" and receives a binding; which engine is behind it is a
provisioning-time choice. That symmetry *is* the demo.

## 4. Previews for Postgres-backed apps

Previews keep the existing per-PR convention (own Worker, own hostname, own
OIDC client — see [previews-and-acl.md](./previews-and-acl.md)); only the
database layer changes. PlanetScale Postgres has **no copy-on-write** —
branches are isolated database deployments with their own storage and compute —
so the two preview data modes map onto its two creation paths:

| `previewDataMode` | Mechanism | Cost / latency | Use |
| --- | --- | --- | --- |
| `empty` (**default**) | `pscale branch create <db> <pr-branch> --wait`, then run migrations + optional seed | ~$5/mo prorated (~$0.16/day); ready in ~a minute | Normal PR previews |
| `copy` (opt-in) | `pscale branch create <db> <pr-branch> --restore <backup> --wait` | Minutes (backup restore); full storage cost; inherits cluster size | "Test against a real snapshot" previews |

- This is exactly the **configurable empty-vs-production-copy knob** — a flag
  on the preview request, not new platform plumbing.
- PlanetScale explicitly warns against production data in dev branches (PII).
  For a platform vending previews to many apps, **`empty` stays the default**
  and `copy` is an explicit per-app opt-in. That policy is encoded once in
  provisioning, not left to app authors.
- Each preview branch gets its own Hyperdrive config (it is a distinct host),
  torn down with the preview.
- Limits: 100 dev branches per database by default, configurable to 5,000.
  Teardown on PR close matters (the same discipline the D1 path already needs
  for the 10-database D1 account limit).

**Scope note for the demo:** implement §3 (fresh Postgres apps) first. Preview
branching for Postgres apps is a fast-follow — D1 previews already prove the
preview concept, and Postgres preview branching is where the fiddly bits
(branch-readiness waits, backup-restore latency, per-preview Hyperdrive
lifecycle) live.

## 5. Hyperdrive specifics that matter

- **Connection pooling is the non-negotiable.** Workers open a connection per
  invocation; without pooling you exhaust Postgres connections instantly.
  Hyperdrive pools at the edge and near the origin (PlanetScale also runs
  PgBouncer at its proxy layer; Hyperdrive pools on top).
- **Query caching** (default-on) absorbs a big fraction of reads for CRUD-ish
  apps. Keep a **second, cache-disabled Hyperdrive config** for reads that must
  be fresh — auth/session/billing — which matters for the gateway and app
  session middleware.
- Hyperdrive is per-origin. App database → one config; each preview branch →
  its own config. All created/destroyed with the app's Alchemy stack.
- Use a **placement hint** to run the Worker near the database region when a
  request makes multiple queries.

## 6. Capability config impact

The existing `TERRARIUM_DATABASE=cf-d1 | planetscale-hyperdrive` option stays
the user-facing choice. The validation requirements change from "a single
shared host/user/pass/database" (the stub's assumption) to **org-level
provisioning credentials**:

```
PLANETSCALE_SERVICE_TOKEN_ID / PLANETSCALE_SERVICE_TOKEN   # creates databases + branches
PLANETSCALE_ORG_NAME
CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN               # Hyperdrive configs
```

This keeps the "if you say it's supported, prove it" rule honest: enabling
`planetscale-hyperdrive` without org-level credentials is a boot error.

## 7. What this deliberately does not build

- **Shared-DB multi-tenancy** (schemas / prefixes) — cost optimization, scale
  problem, not demo problem.
- **AWS apps on PlanetScale** — AWS apps use **RDS per app**, full stop
  ([deployment-topologies.md](./deployment-topologies.md) §5a). No cross-cloud
  database bindings; Hyperdrive is Cloudflare-only regardless.
- **Neki / Vitess** — PlanetScale's sharded offerings. Unnecessary at any
  plausible Terrarium scale.
