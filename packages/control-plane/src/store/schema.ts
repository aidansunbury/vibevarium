import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type * as McpSchema from "effect/ai/McpSchema";

export type AppStatus = "unknown" | "up" | "down";

export const apps = pgTable("registry_apps", {
  name: text("name").primaryKey(),
  url: text("url").notNull(),
  status: text("status").$type<AppStatus>().notNull().default("unknown"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"),
  /** The app's Logto OIDC client id (set at scaffold; deleted on teardown). */
  oidcClientId: text("oidc_client_id"),
  /** Preview lineage: set on preview apps, the parent app name. Null on prod apps. */
  previewOf: text("preview_of"),
  /** The PR number this preview tracks (previews only). */
  previewPr: text("preview_pr"),
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

// --- Connections (docs/connections.md): user ↔ provider credentials + app grants ---
// Provider OAuth client secrets are NEVER stored here — only a reference the
// SecretsProvider resolves (env var name locally, SM secret name in prod).

export const oauthProviders = pgTable("oauth_providers", {
  name: text("name").primaryKey(),
  displayName: text("display_name").notNull(),
  authorizeUrl: text("authorize_url").notNull(),
  tokenUrl: text("token_url").notNull(),
  userinfoUrl: text("userinfo_url").notNull(),
  apiBaseUrl: text("api_base_url").notNull(),
  clientIdRef: text("client_id_ref").notNull(),
  clientSecretRef: text("client_secret_ref").notNull(),
  defaultScopes: text("default_scopes").notNull(),
  responseMode: text("response_mode").notNull().default("query"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey(),
    userSub: text("user_sub").notNull(),
    provider: text("provider").notNull().references(() => oauthProviders.name, { onDelete: "cascade" }),
    providerAccountSub: text("provider_account_sub").notNull(),
    providerAccountLabel: text("provider_account_label").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    grantedScopes: text("granted_scopes").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    status: text("status").notNull().default("active"), // active | revoked | requires_reauth
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("connections_user_provider_unique").on(table.userSub, table.provider),
    index("connections_provider_status_idx").on(table.provider, table.status),
  ],
);

export const connectionGrants = pgTable(
  "connection_grants",
  {
    id: uuid("id").primaryKey(),
    appId: text("app_id").notNull(),
    provider: text("provider").notNull().references(() => oauthProviders.name, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "cascade" }),
    ownerSub: text("owner_sub"),
    scopes: text("scopes").notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | revoked
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("connection_grants_app_provider_status_idx").on(table.appId, table.provider, table.status),
    index("connection_grants_connection_status_idx").on(table.connectionId, table.status),
  ],
);

export const oauthSessions = pgTable(
  "oauth_sessions",
  {
    state: text("state").primaryKey(),
    userSub: text("user_sub").notNull(),
    provider: text("provider").notNull().references(() => oauthProviders.name, { onDelete: "cascade" }),
    pkceVerifier: text("pkce_verifier").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    requestedScopes: text("requested_scopes").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [index("oauth_sessions_expiry_idx").on(table.expiresAt)],
);

export type OAuthProviderRow = typeof oauthProviders.$inferSelect;
export type ConnectionRow = typeof connections.$inferSelect;
export type ConnectionGrantRow = typeof connectionGrants.$inferSelect;
export type OAuthSessionRow = typeof oauthSessions.$inferSelect;

// --- Provisioning jobs (docs/provisioning.md §3) --------------------------
// A job-based async provision: POST /provisioning returns a job id; the steps
// (repo → OIDC client → deploy → router → directory → discovery) run in a
// background fiber and are persisted here so status survives restarts and the
// wizard can poll/resume.

export type ProvisioningStepState = "pending" | "running" | "done" | "failed";
export interface ProvisioningStep {
  readonly id: string;
  readonly label: string;
  readonly state: ProvisioningStepState;
  readonly detail?: string | undefined;
}
export type ProvisioningJobStatus = "running" | "succeeded" | "failed";

export const provisioningJobs = pgTable("provisioning_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The requested spec: target/database/features (jsonb). */
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<ProvisioningJobStatus>().notNull().default("running"),
  steps: jsonb("steps").$type<Array<ProvisioningStep>>().notNull(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export type ProvisioningJobRow = typeof provisioningJobs.$inferSelect;

export type AppRow = typeof apps.$inferSelect;
export type DirectoryToolRow = typeof directoryTools.$inferSelect;
export type IntegrationRow = typeof integrations.$inferSelect;
export type IntegrationGrantRow = typeof integrationGrants.$inferSelect;
export type ProxyAuditRow = typeof proxyAudit.$inferSelect;
