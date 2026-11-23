# DB spike — PGlite ↔ RDS Postgres, driver-pluggable

The control plane's store was PGlite-on-a-docker-volume (the deliberate
shortcut from `docs/mvp.md`). The prod target is real Postgres on RDS. The
schema was already pg-core (real Postgres DDL) and every caller already talks
drizzle — so the swap is a **driver/connection change, not a schema change**.

## The driver-pluggable design (`src/store/database.ts`)

`Database.layerFromEnv({ databaseUrl, databasePath })` picks one of two layers:

| | `databaseUrl` set | `databaseUrl` unset |
|---|---|---|
| **Driver** | `postgres` (postgres.js, `drizzle-orm/postgres-js`) | `pglite` (embedded, `drizzle-orm/pglite`) |
| **Connects to** | RDS (prod) | PGlite at `databasePath` (or in-memory when unset) |
| **Setup** | `DATABASE_URL` injected from SM | zero — no daemon, no credentials |

Both branches:

- build a drizzle instance with **the same pg-core schema** (`src/store/schema.ts`);
- run **the same idempotent boot DDL** (`BOOT_DDL` — `CREATE TABLE IF NOT
  EXISTS` + `ALTER … ADD COLUMN IF NOT EXISTS`), which is plain Postgres and
  runs as-is on PGlite and real Postgres;
- return `{ db, driver }` where `db`'s public surface is `insert/select/
  update/delete` — the only surface callers (registry, directory, integrations,
  connections) use.

**One type seam**: the two drivers return different `PgDatabase` subclasses
whose *chained query builders* are structurally incompatible in the type
system (the result HKT leaks into every signature) even though the runtime API
is identical. Callers never touch driver internals (`$client`, sessions,
transactions), so the store exposes the postgres.js flavor as `DrizzleDb` and
casts the PGlite instance once, internally (`asDrizzleDb`). The alternative —
typing `db` as a union of both flavors — makes every `.where()` chain fail to
unify; the cast is the smaller lie and the boundary of it is this one file.

**Env precedence**: `DATABASE_URL` wins; `DATABASE_PATH` is the PGlite
fallback. Neither set → in-memory PGlite (the demo/proof path).

## postgres.js over node-postgres

Chosen because it's the cleaner of the two: one `postgres(url)` client, tagged
-template queries the drizzle driver composes natively, and a single
`sql.unsafe(BOOT_DDL)` for the multi-statement boot DDL. Config:
`max: 1` (spike scale — one connection), `prepare: false` (a prepared
statement can outlive its server connection behind RDS connection churn),
`ssl: "require"` (**RDS rejects unencrypted connections** — pg_hba has no
non-SSL entries; `require` encrypts without needing client certs or a local
CA bundle, since the RDS cert chain isn't the point of this verification).

## How local dev stays zero-setup

`pnpm --filter @terrarium/control-plane demo` (and every other local entry
point) sets **no `DATABASE_URL`** → PGlite, embedded, no daemon, no
credentials, no network. Nothing in the local loop changed; `DATABASE_PATH`
still selects an on-disk PGlite dir when set (e.g. `scripts/dev.ts`).

## How the box gets `DATABASE_URL` from SM

The master credentials live in AWS Secrets Manager as the RDS-managed secret
`rds!db-6f5a2477-…` (JSON `{username, password}`). From those parts we
materialized **one** secret the control plane consumes directly:

- SM: `/terrarium/prod/database-url` =
  `postgres://postgres:<url-encoded-pw>@<rds-endpoint>:5432/control_plane`
  (password URL-encoded — it contains `(`, `[`, `*`, `<`).

At boot, `SECRETS_PROVIDER=aws` + the existing `loadBootSecrets` machinery
(`src/secrets/boot.ts`, `AWS_BOOT_SECRETS`) fetches it into
`process.env.DATABASE_URL` before any layer builds — the same
"inject-env-at-boot, real env wins" pattern as every other boot secret. The
compose file therefore has **no password** — just `SECRETS_PROVIDER: aws`,
`AWS_REGION`, `SECRETS_PREFIX`; `src/main.ts` passes `process.env.DATABASE_URL`
into the server options.

## Compose changes (`packages/infra/compose/docker-compose.yml`)

- Removed `DATABASE_PATH: /data/pglite` and the `control_plane_data` volume
  **mount** from the control-plane service — state now lives in RDS.
- The `control_plane_data` volume is **kept declared but unmounted** so one
  manual backup of the pre-RDS PGlite dir can still be taken
  (`docker run --rm -v control_plane_data:/data … tar`); it can be dropped
  with `docker volume rm compose_control_plane_data` afterwards. Not deleted
  outright because deleting the last reference would delete the data before
  the backup decision was made.
- `DATABASE_URL` is deliberately **not** in compose env — it arrives from SM.

## `/config-check` provenance

Shows the database driver + **host only** (never the password):

```json
"database": { "driver": "postgres", "host": "…rds.amazonaws.com:5432",
              "database": "control_plane", "source": "aws-secrets-manager" }
```

Locally it reports `{ "driver": "pglite", "path": "…" | ":memory:" }`.

## Migration choice: re-scaffold, not a data copy

`packages/control-plane/scripts/migrate-to-rds.ts` (PGlite → Postgres, all
tables, FK-safe order, `ON CONFLICT DO NOTHING` so it's idempotent) **was
written and proven against a scratch RDS database** — but **not run in prod**.

At swap time the live PGlite store held exactly:

- 2 `registry_apps` rows (`tickets`, `notes` — both `up`), 8 `directory_tools`;
- **0** integrations, integration_grants, oauth_providers, connections,
  connection_grants, proxy_audit, oauth_sessions.

The valuable rows (integrations/connections) **don't exist yet**, and the two
apps re-register through the normal `/apps` + `/discover` flow in seconds. So
the box was pointed at an empty `control_plane` database and the apps were
re-registered — no dump of the old volume was needed. The migration script
stays in the repo for any future PGlite→RDS move that *does* have data worth
keeping; it is deliberately not wired into boot (one-shot, run by hand on the
box).

## Verifying

- `pnpm exec tsrs --noEmit -p packages/control-plane/tsconfig.json` — clean.
- `pnpm exec oxlint --type-aware packages/control-plane` — warnings only (the
  one new `as unknown as` is the documented driver-type seam above).
- `pnpm --filter @terrarium/control-plane demo` — green on PGlite (no
  `DATABASE_URL`).
- Postgres branch proven end-to-end against a scratch RDS database
  (`cp_driver_test`, dropped after): `Database.layerFromEnv({ databaseUrl })`
  → `driver: "postgres"`, insert + select round-trip, cleanup. Migration
  script proven PGlite→RDS the same way.
