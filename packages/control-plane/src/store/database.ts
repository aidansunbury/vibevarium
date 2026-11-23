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
`;

export class Database extends Context.Service<Database, {
  readonly db: DrizzleDb;
  /** Which driver this layer is running on ("pglite" | "postgres") — observability only. */
  readonly driver: "pglite" | "postgres";
}>()("@terrarium/control-plane/store/Database") {
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
