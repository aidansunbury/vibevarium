import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as schema from "./schema.ts";

/**
 * Driver-pluggable database layer (see DB-SPIKE.md).
 *
 * - `databaseUrl` set (prod: `postgres://user:pass@host:5432/control_plane`)
 *   → real Postgres via postgres.js (`drizzle-orm/postgres-js`). RDS is the
 *   prod target; the box constructs the URL from Secrets Manager at boot.
 * - Otherwise (local dev) → embedded PGlite, optionally persisted at
 *   `dataDir`. Zero setup: no daemon, no credentials.
 *
 * Both branches produce a drizzle instance with the SAME pg-core schema and
 * the SAME query API (`db.insert/select/update/delete`), so every caller
 * (registry, directory, integrations, connections) works unchanged. The
 * idempotent DDL below is plain Postgres — PGlite and real Postgres both run
 * it as-is.
 */
type PostgresDb = ReturnType<typeof drizzlePostgres<typeof schema>>;
type PgliteDb = ReturnType<typeof drizzlePglite<typeof schema>>;

/**
 * The drizzle surface callers use. The two drivers return different
 * `PgDatabase` subclasses whose chained query builders are structurally
 * incompatible in the type system (the result HKT leaks into every method
 * signature) even though the runtime API is identical. Callers never touch
 * driver-specific internals (`$client`, sessions, transactions) — only
 * `insert/select/update/delete` — so the store types the surface as the
 * postgres.js flavor and casts the PGlite instance once, here.
 */
export type DrizzleDb = PostgresDb;

const asDrizzleDb = (db: PgliteDb): DrizzleDb => db as unknown as DrizzleDb;

/** Idempotent boot DDL: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS. */
const BOOT_DDL = `
  CREATE TABLE IF NOT EXISTS registry_apps (
    name text PRIMARY KEY,
    url text NOT NULL,
    status text NOT NULL DEFAULT 'unknown',
    last_seen_at timestamptz,
    last_checked_at timestamptz,
    last_error text
  );

  -- Idempotent column adds for tables created before the column existed.
  ALTER TABLE registry_apps ADD COLUMN IF NOT EXISTS oidc_client_id text;
  ALTER TABLE registry_apps ADD COLUMN IF NOT EXISTS m2m_client_id text;
  CREATE UNIQUE INDEX IF NOT EXISTS registry_apps_m2m_client_id_unique ON registry_apps (m2m_client_id);
  CREATE TABLE IF NOT EXISTS app_oidc_registrations (
    app text PRIMARY KEY REFERENCES registry_apps(name) ON DELETE CASCADE,
    access_token text NOT NULL
  );
  -- Preview lineage (docs/previews-and-acl.md): previews are registry apps too,
  -- flagged with their parent app + PR.
  ALTER TABLE registry_apps ADD COLUMN IF NOT EXISTS preview_of text;
  ALTER TABLE registry_apps ADD COLUMN IF NOT EXISTS preview_pr text;

  CREATE TABLE IF NOT EXISTS directory_tools (
    app_name text NOT NULL REFERENCES registry_apps(name) ON DELETE CASCADE,
    remote_name text NOT NULL,
    gateway_name text NOT NULL UNIQUE,
    descriptor jsonb NOT NULL,
    discovered_at timestamptz NOT NULL,
    stale boolean NOT NULL DEFAULT false,
    PRIMARY KEY (app_name, remote_name)
  );

  CREATE TABLE IF NOT EXISTS integrations (
    name text PRIMARY KEY,
    base_url text NOT NULL,
    token_env text NOT NULL,
    auth_header text NOT NULL DEFAULT 'authorization_bearer',
    timeout_ms text NOT NULL DEFAULT '10000',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS integration_grants (
    app text NOT NULL,
    integration text NOT NULL REFERENCES integrations(name) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app, integration)
  );

  CREATE TABLE IF NOT EXISTS proxy_audit (
    id text PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    caller_kind text NOT NULL,
    caller text NOT NULL,
    app text NOT NULL,
    integration text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    status text NOT NULL,
    duration_ms text NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_providers (
    name text PRIMARY KEY,
    display_name text NOT NULL,
    authorize_url text NOT NULL,
    token_url text NOT NULL,
    userinfo_url text NOT NULL,
    api_base_url text NOT NULL,
    client_id_ref text NOT NULL,
    client_secret_ref text NOT NULL,
    default_scopes text NOT NULL,
    response_mode text NOT NULL DEFAULT 'query',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS connections (
    id uuid PRIMARY KEY,
    user_sub text NOT NULL,
    provider text NOT NULL REFERENCES oauth_providers(name) ON DELETE CASCADE,
    provider_account_sub text NOT NULL,
    provider_account_label text NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    granted_scopes text NOT NULL,
    expires_at bigint,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS connections_user_provider_unique ON connections(user_sub, provider);
  CREATE INDEX IF NOT EXISTS connections_provider_status_idx ON connections(provider, status);

  CREATE TABLE IF NOT EXISTS connection_grants (
    id uuid PRIMARY KEY,
    app_id text NOT NULL,
    provider text NOT NULL REFERENCES oauth_providers(name) ON DELETE CASCADE,
    connection_id uuid REFERENCES connections(id) ON DELETE CASCADE,
    owner_sub text,
    scopes text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS connection_grants_app_provider_status_idx ON connection_grants(app_id, provider, status);
  CREATE INDEX IF NOT EXISTS connection_grants_connection_status_idx ON connection_grants(connection_id, status);

  CREATE TABLE IF NOT EXISTS oauth_sessions (
    state text PRIMARY KEY,
    user_sub text NOT NULL,
    provider text NOT NULL REFERENCES oauth_providers(name) ON DELETE CASCADE,
    pkce_verifier text NOT NULL,
    redirect_uri text NOT NULL,
    requested_scopes text NOT NULL,
    expires_at bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS oauth_sessions_expiry_idx ON oauth_sessions(expires_at);

  -- Durable control-plane GUI sessions and one-time OIDC/PKCE transactions.
  -- Raw cookie IDs and state are HMAC/SHA-256 hashes; credentials are encrypted.
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash text PRIMARY KEY,
    user_sub text NOT NULL,
    user_name text NOT NULL,
    access_token_encrypted text NOT NULL,
    id_token_encrypted text NOT NULL,
    refresh_token_encrypted text,
    access_token_expires_at timestamptz NOT NULL,
    session_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(session_expires_at);
  CREATE INDEX IF NOT EXISTS sessions_user_sub_idx ON sessions(user_sub);

  CREATE TABLE IF NOT EXISTS session_transactions (
    id_hash text PRIMARY KEY,
    pkce_verifier_encrypted text NOT NULL,
    state_hash text NOT NULL,
    return_to text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS session_transactions_expiry_idx ON session_transactions(expires_at);

  -- Jobs (docs/internal/jobs.md): the unified durable-async engine. One jobs row per
  -- unit of background work (provision, deliver_webhook); job_steps checkpoint
  -- each step so a restarted process resumes where the dead one stopped. The
  -- legacy provisioning_jobs + event_deliveries tables both fold into these.
  CREATE TABLE IF NOT EXISTS jobs (
    id text PRIMARY KEY,
    kind text NOT NULL,
    name text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempts text NOT NULL DEFAULT '0',
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    result jsonb,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS jobs_drain_idx ON jobs(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS jobs_kind_idx ON jobs(kind);
  CREATE INDEX IF NOT EXISTS jobs_name_idx ON jobs(name);

  CREATE TABLE IF NOT EXISTS job_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    step_id text NOT NULL,
    label text NOT NULL,
    ordinal text NOT NULL,
    state text NOT NULL DEFAULT 'pending',
    detail text,
    attempt text NOT NULL DEFAULT '0',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS job_steps_job_idx ON job_steps(job_id);

  -- Drop the superseded per-feature job tables (idempotent; safe on fresh + old DBs).
  DROP TABLE IF EXISTS provisioning_jobs;
  DROP TABLE IF EXISTS event_deliveries;

  -- App ACLs (docs/previews-and-acl.md Part 2): the control plane owns the
  -- policy; enforcement lives at the app/router/gateway at request time.
  CREATE TABLE IF NOT EXISTS app_acl (
    app text PRIMARY KEY REFERENCES registry_apps(name) ON DELETE CASCADE,
    visibility text NOT NULL DEFAULT 'internal',
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS app_acl_members (
    app text NOT NULL REFERENCES registry_apps(name) ON DELETE CASCADE,
    user_sub text NOT NULL,
    role text NOT NULL,
    source text NOT NULL DEFAULT 'local',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app, user_sub)
  );

  -- Platform-wide roles: 'superadmin' bypasses every per-app ACL check.
  CREATE TABLE IF NOT EXISTS platform_roles (
    user_sub text PRIMARY KEY,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Events (docs/internal/events.md): central webhook ingress sources + per-app
  -- subscriptions + the delivery outbox. Source secrets are references
  -- resolved by the SecretsProvider, never stored.
  CREATE TABLE IF NOT EXISTS webhook_sources (
    name text PRIMARY KEY,
    display_name text NOT NULL,
    secret_ref text NOT NULL,
    verification text NOT NULL DEFAULT 'hmac-sha256',
    event_type_header text,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS event_subscriptions (
    id uuid PRIMARY KEY,
    app text NOT NULL REFERENCES registry_apps(name) ON DELETE CASCADE,
    source text NOT NULL REFERENCES webhook_sources(name) ON DELETE CASCADE,
    event_types jsonb NOT NULL DEFAULT '[]',
    scopes jsonb NOT NULL DEFAULT '[]',
    filter jsonb,
    status text NOT NULL DEFAULT 'active',
    delivery_secret_ref text,
    max_attempts text,
    retry_schedule text,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS event_subscriptions_source_idx ON event_subscriptions(source, status);
  CREATE INDEX IF NOT EXISTS event_subscriptions_app_idx ON event_subscriptions(app);
`;

export class Database extends Context.Service<Database, {
  readonly db: DrizzleDb;
  /** Which driver this layer is running on ("pglite" | "postgres") — observability only. */
  readonly driver: "pglite" | "postgres";
}>()("@vibevarium/control-plane/store/Database") {
  /** Real Postgres (prod/RDS). postgres.js, one connection is enough at spike scale. */
  static readonly postgresLayer = (databaseUrl: string) =>
    Layer.effect(Database)(Effect.gen(function*() {
      const sql = yield* Effect.acquireRelease(
        // ssl:"require" — RDS rejects unencrypted connections (pg_hba has no
        // non-SSL entries). prepare:false — behind RDS connection churn a
        // prepared statement can outlive its server connection; no hot paths
        // at spike scale, so correctness beats the micro-optimization.
        Effect.sync(() => postgres(databaseUrl, { max: 1, prepare: false, ssl: "require" })),
        (client) => Effect.promise(() => client.end()).pipe(Effect.ignore),
      );
      yield* Effect.promise(() => sql.unsafe(BOOT_DDL));
      return Database.of({ db: drizzlePostgres(sql, { schema }), driver: "postgres" });
    }));

  /** Embedded PGlite (local dev default). In-memory when `dataDir` is unset. */
  static readonly pgliteLayer = (dataDir?: string) =>
    Layer.effect(Database)(Effect.gen(function*() {
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => dataDir === undefined ? PGlite.create() : PGlite.create(dataDir)),
        (openClient) => Effect.promise(() => openClient.close()).pipe(Effect.ignore),
      );
      yield* Effect.promise(() => client.exec(BOOT_DDL));
      return Database.of({ db: asDrizzleDb(drizzlePglite({ client, schema })), driver: "pglite" });
    }));

  /** Pglite layer (back-compat alias; prefer pgliteLayer / postgresLayer). */
  static readonly layer = (dataDir?: string) => Database.pgliteLayer(dataDir);

  /** Env-driven selection: DATABASE_URL wins; DATABASE_PATH is the PGlite fallback. */
  static readonly layerFromEnv = (options: { databaseUrl?: string | undefined; databasePath?: string | undefined }) =>
    options.databaseUrl !== undefined
      ? Database.postgresLayer(options.databaseUrl)
      : Database.pgliteLayer(options.databasePath);
}
