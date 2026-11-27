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
  /** The app's OIDC client id (set at scaffold via Casdoor DCR; deleted on teardown). */
  oidcClientId: text("oidc_client_id"),
  m2mClientId: text("m2m_client_id").unique(),
  /** Preview lineage: set on preview apps, the parent app name. Null on prod apps. */
  previewOf: text("preview_of"),
  /** The PR number this preview tracks (previews only). */
  previewPr: text("preview_pr"),
});

export const appOidcRegistrations = pgTable("app_oidc_registrations", {
  app: text("app").primaryKey().references(() => apps.name, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
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

// --- Control-plane GUI auth ---------------------------------------------------
// Opaque browser cookies reference these durable rows by HMAC. Credentials and
// PKCE verifiers are AES-256-GCM encrypted before they reach the database.

export const sessions = pgTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userSub: text("user_sub").notNull(),
    userName: text("user_name").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    idTokenEncrypted: text("id_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "string" }).notNull(),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_expiry_idx").on(table.sessionExpiresAt),
    index("sessions_user_sub_idx").on(table.userSub),
  ],
);

export const sessionTransactions = pgTable(
  "session_transactions",
  {
    idHash: text("id_hash").primaryKey(),
    pkceVerifierEncrypted: text("pkce_verifier_encrypted").notNull(),
    stateHash: text("state_hash").notNull(),
    returnTo: text("return_to"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [index("session_transactions_expiry_idx").on(table.expiresAt)],
);

export type SessionRow = typeof sessions.$inferSelect;
export type SessionTransactionRow = typeof sessionTransactions.$inferSelect;

// --- Jobs (docs/internal/jobs.md): the unified durable-async primitive ---------------
// One jobs row = one unit of durable background work (provision an app,
// deliver a webhook). The JobRunner drains due rows and dispatches on `kind`;
// a job's payload carries its input, and its job_steps rows checkpoint each
// step so a fresh process resumes where a dead one left off (survives redeploy).

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** Discriminator the JobRunner routes on: "provision" | "deliver_webhook" | ... */
    kind: text("kind").notNull(),
    /** Human label (e.g. the app name) for history/CLI display. */
    name: text("name").notNull(),
    /** The job's input. For deliver_webhook: the envelope + target + signing ref. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    attempts: text("attempts").notNull().default("0"),
    /** When the job next becomes due — the scheduling + backoff column. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** Set at completion: the job's final output (provision result, delivery response). */
    result: jsonb("result").$type<Record<string, unknown>>(),
    /** Last failure detail (terminal or most-recent transient). */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("jobs_drain_idx").on(table.status, table.nextAttemptAt),
    index("jobs_kind_idx").on(table.kind),
    index("jobs_name_idx").on(table.name),
  ],
);

export type JobStepState = "pending" | "running" | "done" | "failed" | "skipped";

/** One step in a multi-step job (provisioning's repo→oidc→deploy→…; a single-step job has one row). */
export const jobSteps = pgTable(
  "job_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    /** Stable step id within the job ("repo" | "oidc" | "deploy" | "post" | ...). */
    stepId: text("step_id").notNull(),
    label: text("label").notNull(),
    /** Order within the job — the runner resumes at the first non-done step. */
    ordinal: text("ordinal").notNull(),
    state: text("state").$type<JobStepState>().notNull().default("pending"),
    /** What the step produced / its failure detail (deploy URL, webhook response status). */
    detail: text("detail"),
    attempt: text("attempt").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [index("job_steps_job_idx").on(table.jobId)],
);

export type JobRow = typeof jobs.$inferSelect;
export type JobStepRow = typeof jobSteps.$inferSelect;

// --- App ACLs (docs/previews-and-acl.md Part 2) ----------------------------
// The control plane OWNS the ACL policy as Tier 1/2 facts keyed by `sub`;
// enforcement at request time belongs to the app/router/gateway (each block
// authorizes itself). `source` makes the model sync-ready: a future external
// directory (Okta groups/SCIM) writes source='external' rows and never fights
// manual 'local' grants.

export type AppVisibility = "internal" | "restricted";
export type AclRole = "admin" | "member";
export type AclSource = "local" | "external";

export const appAcl = pgTable("app_acl", {
  app: text("app").primaryKey().references(() => apps.name, { onDelete: "cascade" }),
  visibility: text("visibility").$type<AppVisibility>().notNull().default("internal"),
  /** The creator's sub — the immutable admin seed from provision time. */
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const appAclMembers = pgTable(
  "app_acl_members",
  {
    app: text("app")
      .notNull()
      .references(() => apps.name, { onDelete: "cascade" }),
    userSub: text("user_sub").notNull(),
    role: text("role").$type<AclRole>().notNull(),
    /** 'local' = manual grant via the GUI/API; 'external' = synced from a directory (Okta/SCIM later). */
    source: text("source").$type<AclSource>().notNull().default("local"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.app, table.userSub] })],
);

export const platformRoles = pgTable("platform_roles", {
  userSub: text("user_sub").primaryKey(),
  /** Platform-wide role. 'superadmin' bypasses every ACL check + gates sensitive platform ops. */
  role: text("role").$type<"superadmin">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/** Durable record of users who have signed into the platform. */
export const platformUsers = pgTable("platform_users", {
  sub: text("sub").primaryKey(),
  name: text("name"),
  email: text("email"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export type AppAclRow = typeof appAcl.$inferSelect;
export type AppAclMemberRow = typeof appAclMembers.$inferSelect;
export type PlatformRoleRow = typeof platformRoles.$inferSelect;
export type PlatformUserRow = typeof platformUsers.$inferSelect;

// --- Events (docs/internal/events.md): provider webhook sources + per-app subscriptions ---
// The control plane owns a central ingress per source; providers POST their
// firehose there once, and the dispatcher fans each event out to every
// subscription whose structured match fits. Source secrets are NEVER stored
// here — only a reference the SecretsProvider resolves (same seam as OAuth
// providers / integration tokens).

/**
 * Payload predicate (Layer 2 filtering): an allowlisted predicate ANDed
 * against the event's indexable metadata + payload. `path` is a dotted string
 * (into the payload); ops are deliberately non-Turing-complete.
 */
export interface EventFilterClause {
  readonly path: string;
  readonly op: "eq" | "neq" | "prefix" | "in" | "exists";
  readonly value?: unknown;
}

export const webhookSources = pgTable("webhook_sources", {
  name: text("name").primaryKey(), // e.g. "github", "stripe"
  displayName: text("display_name").notNull(),
  /** SecretsProvider reference for the ingress verification secret (env var name locally, SM name in prod). */
  secretRef: text("secret_ref").notNull(),
  /** Verification scheme the ingress applies to incoming POSTs. */
  verification: text("verification").notNull().default("hmac-sha256"), // hmac-sha256 | bearer | none
  /** Header carrying the provider event type (e.g. X-GitHub-Event, Stripe passes it in the body). */
  eventTypeHeader: text("event_type_header"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: uuid("id").primaryKey(),
    app: text("app").notNull().references(() => apps.name, { onDelete: "cascade" }),
    source: text("source").notNull().references(() => webhookSources.name, { onDelete: "cascade" }),
    /** Provider event types to receive (["push", "check_suite"]); empty = all types from the source. */
    eventTypes: jsonb("event_types").$type<ReadonlyArray<string>>().notNull().default([]),
    /** Structured narrowing (Layer 1): repos/accounts the subscription is scoped to; empty = all. */
    scopes: jsonb("scopes").$type<ReadonlyArray<string>>().notNull().default([]),
    /** Optional payload predicate (Layer 2); null = no payload filtering. */
    filter: jsonb("filter").$type<ReadonlyArray<EventFilterClause>>(),
    status: text("status").notNull().default("active"), // active | paused
    /** SecretsProvider reference for this app's delivery-signing secret (set at provisioning/scaffold). */
    deliverySecretRef: text("delivery_secret_ref"),
    /** Per-subscription retry overrides; null = platform default (env). */
    maxAttempts: text("max_attempts"),
    retrySchedule: text("retry_schedule"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("event_subscriptions_source_idx").on(table.source, table.status),
    index("event_subscriptions_app_idx").on(table.app),
  ],
);

// NOTE: webhook DELIVERY rows are not a separate table. Each fan-out delivery
// is a `jobs` row (kind = "deliver_webhook") whose payload carries the envelope
// + target app + signing-secret reference; the JobRunner drains and signs it.
// This keeps the delivery outbox and provisioning on one durable-async engine.

export type WebhookSourceRow = typeof webhookSources.$inferSelect;
export type EventSubscriptionRow = typeof eventSubscriptions.$inferSelect;

export type AppRow = typeof apps.$inferSelect;
export type DirectoryToolRow = typeof directoryTools.$inferSelect;
export type IntegrationRow = typeof integrations.$inferSelect;
export type IntegrationGrantRow = typeof integrationGrants.$inferSelect;
export type ProxyAuditRow = typeof proxyAudit.$inferSelect;
