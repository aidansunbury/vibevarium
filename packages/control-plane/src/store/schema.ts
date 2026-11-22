import { boolean, jsonb, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import type * as McpSchema from "effect/ai/McpSchema";

export type AppStatus = "unknown" | "up" | "down";

export const apps = pgTable("registry_apps", {
  name: text("name").primaryKey(),
  url: text("url").notNull(),
  status: text("status").$type<AppStatus>().notNull().default("unknown"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"),
});

export const directoryTools = pgTable(
  "directory_tools",
  {
    appName: text("app_name")
      .notNull()
      .references(() => apps.name, { onDelete: "cascade" }),
    remoteName: text("remote_name").notNull(),
    gatewayName: text("gateway_name").notNull(),
    descriptor: jsonb("descriptor").$type<McpSchema.Tool>().notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true, mode: "string" }).notNull(),
    stale: boolean("stale").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.appName, table.remoteName] }),
    unique("directory_tools_gateway_name_unique").on(table.gatewayName),
  ],
);

export const integrations = pgTable("integrations", {
  name: text("name").primaryKey(),
  baseUrl: text("base_url").notNull(),
  tokenEnv: text("token_env").notNull(),
  // authorization_bearer | authorization | x-api-key | none
  authHeader: text("auth_header").notNull().default("authorization_bearer"),
  timeoutMs: text("timeout_ms").notNull().default("10000"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const integrationGrants = pgTable(
  "integration_grants",
  {
    app: text("app").notNull(),
    integration: text("integration").notNull().references(() => integrations.name, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.app, table.integration] })],
);

export const proxyAudit = pgTable("proxy_audit", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  callerKind: text("caller_kind").notNull(), // user | app
  caller: text("caller").notNull(),
  app: text("app").notNull(),
  integration: text("integration").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: text("status").notNull(),
  durationMs: text("duration_ms").notNull(),
});

export type AppRow = typeof apps.$inferSelect;
export type DirectoryToolRow = typeof directoryTools.$inferSelect;
export type IntegrationRow = typeof integrations.$inferSelect;
export type IntegrationGrantRow = typeof integrationGrants.$inferSelect;
export type ProxyAuditRow = typeof proxyAudit.$inferSelect;
