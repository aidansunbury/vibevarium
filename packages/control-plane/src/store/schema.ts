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

export type AppRow = typeof apps.$inferSelect;
export type DirectoryToolRow = typeof directoryTools.$inferSelect;
