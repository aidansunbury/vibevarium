import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

export const oauthClients = pgTable("oauth_clients", {
  name: text("name").primaryKey(),
  displayName: text("display_name").notNull(),
  authorizeUrl: text("authorize_url").notNull(),
  tokenUrl: text("token_url").notNull(),
  userinfoUrl: text("userinfo_url").notNull(),
  apiBaseUrl: text("api_base_url").notNull(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
  defaultScopes: text("default_scopes").notNull(),
  responseMode: text("response_mode").notNull().default("query"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
})

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey(),
  userSub: text("user_sub").notNull(),
  provider: text("provider").notNull().references(() => oauthClients.name, { onDelete: "cascade" }),
  providerAccountSub: text("provider_account_sub").notNull(),
  providerAccountLabel: text("provider_account_label").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  grantedScopes: text("granted_scopes").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("connections_user_provider_unique").on(table.userSub, table.provider),
  index("connections_provider_status_idx").on(table.provider, table.status)
])

export const grants = pgTable("grants", {
  id: uuid("id").primaryKey(),
  appId: text("app_id").notNull(),
  provider: text("provider").notNull().references(() => oauthClients.name, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "cascade" }),
  ownerSub: text("owner_sub"),
  scopes: text("scopes").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true })
}, (table) => [
  index("grants_app_provider_status_idx").on(table.appId, table.provider, table.status),
  index("grants_connection_status_idx").on(table.connectionId, table.status)
])

export const oauthSessions = pgTable("oauth_sessions", {
  state: text("state").primaryKey(),
  userSub: text("user_sub").notNull(),
  provider: text("provider").notNull().references(() => oauthClients.name, { onDelete: "cascade" }),
  pkceVerifier: text("pkce_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  requestedScopes: text("requested_scopes").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("oauth_sessions_expiry_idx").on(table.expiresAt)
])

export type OAuthClientRow = typeof oauthClients.$inferSelect
export type ConnectionRow = typeof connections.$inferSelect
export type GrantRow = typeof grants.$inferSelect
export type OAuthSessionRow = typeof oauthSessions.$inferSelect
