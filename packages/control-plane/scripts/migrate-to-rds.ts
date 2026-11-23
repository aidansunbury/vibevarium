/**
 * migrate-to-rds — copy the control-plane store from PGlite to Postgres (RDS).
 *
 * Reads every table from a PGlite data dir (SOURCE_PGLITE, or DATABASE_PATH)
 * and inserts the rows into the target (DATABASE_URL). Idempotent:
 * ON CONFLICT DO NOTHING on every table, so re-runs are safe.
 *
 * This script is intentionally NOT wired into boot — the swap is driver-pluggable,
 * so the box points at RDS via DATABASE_URL and this is a one-shot copy run by
 * hand on the box (inside the control-plane container):
 *
 *   docker exec -it compose-control-plane-1 \
 *     tsx packages/control-plane/scripts/migrate-to-rds.ts
 *
 * Env:
 *   SOURCE_PGLITE   PGlite data dir to read from (default DATABASE_PATH, required)
 *   DATABASE_URL    postgres:// target (required)
 *
 * DECISION (2026-11-23): this script was written but NOT run in production.
 * At swap time the PGlite store held exactly 2 registry rows (tickets, notes —
 * re-registrable in seconds through the normal /apps + /discover flow) and
 * ZERO integrations / connections / providers. Re-scaffolding the two apps was
 * the cheaper and cleaner path; see DB-SPIKE.md "Migration choice".
 */
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

const TABLES = [
  // FK-safe order: parents before children.
  "registry_apps",
  "directory_tools",
  "integrations",
  "integration_grants",
  "oauth_providers",
  "connections",
  "connection_grants",
  "oauth_sessions",
  "proxy_audit",
] as const;

const sourceDir = process.env.SOURCE_PGLITE ?? process.env.DATABASE_PATH;
const targetUrl = process.env.DATABASE_URL;

if (sourceDir === undefined) {
  console.error("SOURCE_PGLITE (or DATABASE_PATH) is required — the PGlite data dir to read from");
  process.exit(1);
}
if (targetUrl === undefined) {
  console.error("DATABASE_URL is required — the postgres:// target");
  process.exit(1);
}

const pglite = await PGlite.create(sourceDir);
const sql = postgres(targetUrl, { max: 1, prepare: false, ssl: "require" });

let totalRows = 0;
for (const table of TABLES) {
  const { rows } = await pglite.query(`SELECT * FROM ${table}`);
  if (rows.length === 0) {
    console.log(`${table}: 0 rows (skipped)`);
    continue;
  }
  const columns = Object.keys(rows[0] as Record<string, unknown>);
  // postgres.js bulk insert helper, ON CONFLICT DO NOTHING keeps it idempotent.
  const inserted = await sql`
    INSERT INTO ${sql(table)} ${sql(rows as Array<Record<string, unknown>>, ...columns)}
    ON CONFLICT DO NOTHING
  `;
  totalRows += rows.length;
  console.log(`${table}: ${rows.length} rows read, ${inserted.count} inserted (conflicts skipped)`);
}

await pglite.close();
await sql.end();
console.log(`Done — ${totalRows} rows considered across ${TABLES.length} tables.`);
