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

          CREATE TABLE IF NOT EXISTS directory_tools (
            app_name text NOT NULL REFERENCES registry_apps(name) ON DELETE CASCADE,
            remote_name text NOT NULL,
            gateway_name text NOT NULL UNIQUE,
            descriptor jsonb NOT NULL,
            discovered_at timestamptz NOT NULL,
            stale boolean NOT NULL DEFAULT false,
            PRIMARY KEY (app_name, remote_name)
          );
        `)
      );
      return Database.of({ db: drizzle({ client, schema }) });
    }));
}
