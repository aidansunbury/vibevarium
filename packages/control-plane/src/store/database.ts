import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as schema from "./schema.ts";

export class Database extends Context.Service<Database, {
  readonly db: PgliteDatabase<typeof schema>;
}>()("@terrarium/control-plane/store/Database") {
  static readonly layer = (dataDir?: string) =>
    Layer.effect(Database)(Effect.gen(function*() {
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => dataDir === undefined ? PGlite.create() : PGlite.create(dataDir)),
        (openClient) => Effect.promise(() => openClient.close()).pipe(Effect.ignore),
      );
      yield* Effect.promise(() =>
        client.exec(`
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
        `)
      );
      return Database.of({ db: drizzle({ client, schema }) });
    }));
}
