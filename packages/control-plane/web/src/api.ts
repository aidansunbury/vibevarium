/**
 * The control-plane API client — typed, Effect-generated, no raw fetch strings.
 *
 * The control plane's routes are HAND-WRITTEN (HttpRouter in src/server.ts,
 * src/scaffold, src/integrations, src/connections), not a domain `HttpApi` —
 * so unlike the app template (which vendors the domain `HttpApi` for
 * `HttpApiClient`), there's no server-side declaration to reuse. Instead this
 * module declares the exact request/response surface as a typed `HttpApi`
 * (Schema-validated) and hands it to `effect/http-api/HttpApiClient`, which
 * derives the client. The endpoint shapes below mirror the hand-written
 * routes one-to-one; when a route changes, update its endpoint here (the
 * routes are the source of truth — there is no OpenAPI doc on the control
 * plane, unlike the app's /openapi.json).
 *
 * Auth: a first-party session cookie set by the server's /auth/callback — no
 * token is held in JS; every call is `credentials: "same-origin"`. A 401 maps
 * to `UnauthenticatedError` and the router bounces to /auth/login.
 */
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** The request was rejected as unauthenticated; the router bounces to /auth/login. */
export class UnauthenticatedError extends Error {
  readonly _tag = "UnauthenticatedError";
}

export const isUnauthenticated = (error: unknown): error is UnauthenticatedError =>
  error instanceof UnauthenticatedError ||
  (typeof error === "object" && error !== null && (error as { _tag?: string })._tag === "UnauthenticatedError");

/** A non-2xx that isn't a 401 — status plus the server's error body. */
export class ApiError extends Error {
  readonly _tag = "ApiError";
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null && "error_description" in body
        ? String((body as { error_description: unknown }).error_description)
        : `HTTP ${status}`,
    );
  }
}

/**
 * Every gated route 401s with this body when the session is missing/expired.
 * DECLARED on every endpoint below: without it, Effect's HttpApiClient throws
 * "Decode: undeclared status code (401 …)" — an error shape isSessionExpired
 * can't match, so the session bounce never fires and the raw decode error
 * leaks into the page (the integrations-page bug). With the declaration, a
 * 401 decodes into this schema and isSessionExpired matches `response.status`.
 */
const ErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});
const Unauthorized = ErrorBody.pipe(HttpApiSchema.status(401));
const Forbidden = ErrorBody.pipe(HttpApiSchema.status(403));

export const isApiError = (error: unknown): error is ApiError =>
  error instanceof ApiError ||
  (typeof error === "object" && error !== null && (error as { _tag?: string })._tag === "ApiError");

export const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "error_description" in error) {
    const description = error.error_description;
    if (typeof description === "string") return description;
  }
  return error instanceof Error ? error.message : String(error);
};

// --- response schemas (mirror the hand-written routes) ------------------------

export const Actor = Schema.Struct({ sub: Schema.String, name: Schema.optional(Schema.String) });
export type Actor = typeof Actor.Type;

export const AppRow = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  status: Schema.Literals(["unknown", "up", "down"]),
  lastSeenAt: Schema.NullOr(Schema.String),
  lastCheckedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  previewOf: Schema.NullOr(Schema.String),
  previewPr: Schema.NullOr(Schema.String),
});
export type AppRow = typeof AppRow.Type;

export const PreviewRow = Schema.Struct({
  name: Schema.String,
  previewOf: Schema.String,
  previewPr: Schema.NullOr(Schema.String),
  url: Schema.String,
  status: Schema.Literals(["unknown", "up", "down"]),
});
export type PreviewRow = typeof PreviewRow.Type;

export const DirectoryTool = Schema.Struct({
  appName: Schema.String,
  appUrl: Schema.String,
  appStatus: Schema.Literals(["unknown", "up", "down"]),
  remoteName: Schema.String,
  gatewayName: Schema.String,
  descriptor: Schema.Struct({ description: Schema.optional(Schema.String) }),
  discoveredAt: Schema.String,
  stale: Schema.Boolean,
});
export type DirectoryTool = typeof DirectoryTool.Type;

export const IntegrationView = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.String,
  tokenEnv: Schema.String,
  authHeader: Schema.String,
  timeoutMs: Schema.Number,
  tokenConfigured: Schema.Boolean,
  createdAt: Schema.String,
});
export type IntegrationView = typeof IntegrationView.Type;

export const AuditRow = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  callerKind: Schema.String,
  caller: Schema.String,
  app: Schema.String,
  integration: Schema.String,
  method: Schema.String,
  path: Schema.String,
  status: Schema.String,
  durationMs: Schema.String,
});
export type AuditRow = typeof AuditRow.Type;

export const GrantPair = Schema.Struct({ app: Schema.String, integration: Schema.String });

export const EventSourceView = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  verification: Schema.String,
  eventTypeHeader: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  secretConfigured: Schema.Boolean,
  createdAt: Schema.String,
});
export type EventSourceView = typeof EventSourceView.Type;

export const EventSubscriptionView = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  source: Schema.String,
  eventTypes: Schema.Array(Schema.String),
  scopes: Schema.Array(Schema.String),
  filter: Schema.NullOr(Schema.Array(Schema.Unknown)),
  status: Schema.String,
  deliveryConfigured: Schema.Boolean,
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type EventSubscriptionView = typeof EventSubscriptionView.Type;

export const EventDeliveryView = Schema.Struct({
  id: Schema.String,
  subscriptionId: Schema.String,
  eventId: Schema.NullOr(Schema.String),
  source: Schema.String,
  eventType: Schema.String,
  status: Schema.String,
  attempts: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  lastStatus: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type EventDeliveryView = typeof EventDeliveryView.Type;
export type GrantPair = typeof GrantPair.Type;

export const ProviderView = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  logoUrl: Schema.optional(Schema.String),
  defaultScopes: Schema.Array(Schema.String),
  configured: Schema.Boolean,
});
export type ProviderView = typeof ProviderView.Type;

export const ConnectionView = Schema.Struct({
  connection_id: Schema.String,
  user_sub: Schema.String,
  provider: Schema.String,
  provider_account: Schema.Struct({ sub: Schema.String, label: Schema.String }),
  granted_scopes: Schema.Array(Schema.String),
  expires_at: Schema.NullOr(Schema.String),
  status: Schema.String,
});
export type ConnectionView = typeof ConnectionView.Type;

export const GrantView = Schema.Struct({
  grant_id: Schema.String,
  app_id: Schema.String,
  provider: Schema.String,
  connection_id: Schema.NullOr(Schema.String),
  owner_sub: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  status: Schema.String,
  created_at: Schema.String,
});
export type GrantView = typeof GrantView.Type;

// --- Set-only secrets (docs/redeployment-plan.md §3) --------------------------

/** A secret's name + provenance — never its value (the set-only trust model). */
export const SecretMeta = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  lastChangedDate: Schema.optional(Schema.String),
});
export type SecretMeta = typeof SecretMeta.Type;

// --- App ACLs (docs/previews-and-acl.md Part 2) -------------------------------

export const AclMember = Schema.Struct({
  app: Schema.String,
  userSub: Schema.String,
  role: Schema.Literals(["admin", "member"]),
  source: Schema.Literals(["local", "external"]),
  createdAt: Schema.String,
});
export type AclMember = typeof AclMember.Type;

export const AppAcl = Schema.Struct({
  app: Schema.String,
  visibility: Schema.Literals(["internal", "restricted"]),
  createdBy: Schema.NullOr(Schema.String),
  members: Schema.Array(AclMember),
  caller: Schema.Struct({
    sub: Schema.NullOr(Schema.String),
    isAdmin: Schema.Boolean,
    isSuperadmin: Schema.Boolean,
  }),
});
export type AppAcl = typeof AppAcl.Type;

// The scaffold result has optional/loose fields; keep it typed but permissive.
export const ScaffoldResult = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  audience: Schema.String,
  repoUrl: Schema.String,
  processId: Schema.Number,
});
export type ScaffoldResult = typeof ScaffoldResult.Type;

// --- provisioning (docs/provisioning.md) -------------------------------------

export const CapabilityStatus = Schema.Struct({
  enabled: Schema.Boolean,
  credentialsValid: Schema.Boolean,
  missing: Schema.Array(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type CapabilityStatus = typeof CapabilityStatus.Type;

export const ProvisioningOptions = Schema.Struct({
  defaultTarget: Schema.Literals(["cloudflare", "aws"]),
  defaultDatabase: Schema.Literals(["cf-d1", "planetscale-hyperdrive"]),
  authProvider: Schema.Literals(["casdoor", "workos"]),
  deployTargets: Schema.Struct({ cloudflare: CapabilityStatus, aws: CapabilityStatus }),
  database: Schema.Struct({
    "cf-d1": CapabilityStatus,
    "planetscale-hyperdrive": CapabilityStatus,
  }),
  features: Schema.Struct({ r2: CapabilityStatus, hyperdrive: CapabilityStatus }),
  authProviders: Schema.Struct({ casdoor: CapabilityStatus, workos: CapabilityStatus }),
});
export type ProvisioningOptions = typeof ProvisioningOptions.Type;

export const ProvisionSpec = Schema.Struct({
  name: Schema.String,
  target: Schema.optional(Schema.Literals(["cloudflare", "aws"])),
  database: Schema.optional(Schema.Literals(["cf-d1", "planetscale-hyperdrive"])),
  features: Schema.optional(Schema.Array(Schema.Literals(["r2", "hyperdrive"]))),
});
export type ProvisionSpec = typeof ProvisionSpec.Type;

export const ProvisionStep = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: Schema.Literals(["pending", "running", "done", "failed"]),
  detail: Schema.optional(Schema.String),
});
export type ProvisionStep = typeof ProvisionStep.Type;

export const ProvisionStatus = Schema.Struct({
  jobId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed"]),
  steps: Schema.Array(ProvisionStep),
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(Schema.String),
  spec: Schema.Record(Schema.String, Schema.Unknown),
});
export type ProvisionStatus = typeof ProvisionStatus.Type;

// --- the typed HttpApi surface -------------------------------------------------

const OpsApi = HttpApi.make("ControlPlane")
  .add(
    HttpApiGroup.make("ops", { topLevel: true })
      .add(HttpApiEndpoint.get("me", "/auth/me", {
        success: Schema.Struct({ actor: Schema.NullOr(Actor), auth: Schema.Literals(["on", "off"]) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("apps", "/apps", {
        success: Schema.Struct({ apps: Schema.Array(AppRow) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("directory", "/directory", {
        success: Schema.Struct({ apps: Schema.Array(AppRow), tools: Schema.Array(DirectoryTool) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("discover", "/discover", { success: Schema.Unknown, error: Unauthorized }))
      .add(HttpApiEndpoint["delete"]("deleteApp", "/apps/:name", {
        params: { name: Schema.String },
        success: Schema.Unknown,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("scaffold", "/scaffold", {
        payload: Schema.Struct({ name: Schema.String }),
        success: Schema.Unknown,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("provisioningOptions", "/provisioning/options", {
        success: ProvisioningOptions,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("provision", "/provisioning", {
        payload: ProvisionSpec,
        success: Schema.Struct({ jobId: Schema.String }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("provisionStatus", "/provisioning/:jobId", {
        params: { jobId: Schema.String },
        success: ProvisionStatus,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("createPreview", "/apps/:name/previews", {
        params: { name: Schema.String },
        payload: Schema.Struct({ pr: Schema.String }),
        success: Schema.Struct({ jobId: Schema.String }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("previews", "/previews", {
        success: Schema.Struct({ previews: Schema.Array(PreviewRow) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("appHistory", "/apps/:name/history", {
        params: { name: Schema.String },
        success: Schema.Struct({ history: Schema.Array(ProvisionStatus) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("appAcl", "/apps/:name/acl", {
        params: { name: Schema.String },
        success: AppAcl,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.put("setVisibility", "/apps/:name/acl/visibility", {
        params: { name: Schema.String },
        payload: Schema.Struct({ visibility: Schema.Literals(["internal", "restricted"]) }),
        success: Schema.Unknown,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("addAclMember", "/apps/:name/acl/members", {
        params: { name: Schema.String },
        payload: Schema.Struct({ sub: Schema.String, role: Schema.Literals(["admin", "member"]) }),
        success: Schema.Unknown,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint["delete"]("removeAclMember", "/apps/:name/acl/members/:sub", {
        params: { name: Schema.String, sub: Schema.String },
        success: Schema.Unknown,
        error: Unauthorized,
      })),
  )
  .add(
    HttpApiGroup.make("integrations", { topLevel: true })
      .add(HttpApiEndpoint.get("integrations", "/integrations", {
        success: Schema.Struct({ integrations: Schema.Array(IntegrationView) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("createIntegration", "/integrations", {
        payload: Schema.Struct({
          name: Schema.String,
          baseUrl: Schema.String,
          tokenEnv: Schema.String,
          authHeader: Schema.optional(Schema.String),
          timeoutMs: Schema.optional(Schema.Number),
        }),
        success: IntegrationView,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("integrationGrants", "/integrations/grants", {
        success: Schema.Struct({ grants: Schema.Array(GrantPair) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("grantIntegration", "/integrations/:integration/grants", {
        params: { integration: Schema.String },
        payload: Schema.Struct({ app: Schema.String }),
        success: Schema.Unknown,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint["delete"]("revokeIntegration", "/integrations/:integration/grants/:app", {
        params: { integration: Schema.String, app: Schema.String },
        success: Schema.Unknown,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("integrationAudit", "/integrations/:integration/audit", {
        params: { integration: Schema.String },
        success: Schema.Struct({ audit: Schema.Array(AuditRow) }),
        error: Unauthorized,
      })),
  )
  .add(
    HttpApiGroup.make("connections", { topLevel: true })
      .add(HttpApiEndpoint.get("providers", "/connections/providers", {
        success: Schema.Struct({ providers: Schema.Array(ProviderView) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("connections", "/connections", {
        success: Schema.Struct({ connections: Schema.Array(ConnectionView) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("startConnection", "/connections/start", {
        payload: Schema.Struct({ provider: Schema.String, scopes: Schema.optional(Schema.Array(Schema.String)) }),
        success: Schema.Struct({ authorization_url: Schema.String }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("revokeConnection", "/connections/revoke", {
        payload: Schema.Struct({ connectionId: Schema.String }),
        success: Schema.Unknown,
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.get("grants", "/grants", {
        success: Schema.Struct({ grants: Schema.Array(GrantView) }),
        error: Unauthorized,
      }))
      .add(HttpApiEndpoint.post("revokeGrant", "/grants/revoke", {
        payload: Schema.Struct({ grantId: Schema.String }),
        success: Schema.Unknown,
        error: Unauthorized,
      })),
  )
  .add(
    HttpApiGroup.make("events", { topLevel: true })
      .add(HttpApiEndpoint.get("eventSources", "/events/sources", {
        success: Schema.Struct({ sources: Schema.Array(EventSourceView) }),
      }))
      .add(HttpApiEndpoint.get("eventSubscriptions", "/events/subscriptions", {
        query: Schema.Struct({ app: Schema.optional(Schema.String), source: Schema.optional(Schema.String) }),
        success: Schema.Struct({ subscriptions: Schema.Array(EventSubscriptionView) }),
      }))
      .add(HttpApiEndpoint.post("subscribeEvent", "/events/subscriptions", {
        payload: Schema.Struct({
          app: Schema.String,
          source: Schema.String,
          eventTypes: Schema.optional(Schema.Array(Schema.String)),
          scopes: Schema.optional(Schema.Array(Schema.String)),
        }),
        success: EventSubscriptionView,
      }))
      .add(HttpApiEndpoint["delete"]("unsubscribeEvent", "/events/subscriptions/:id", {
        params: { id: Schema.String },
        success: Schema.Unknown,
      }))
      .add(HttpApiEndpoint.get("eventDeliveries", "/events/deliveries", {
        query: Schema.Struct({
          subscriptionId: Schema.optional(Schema.String),
          status: Schema.optional(Schema.String),
        }),
        success: Schema.Struct({ deliveries: Schema.Array(EventDeliveryView) }),
      })),
  )
  .add(
    HttpApiGroup.make("secrets", { topLevel: true })
      .add(HttpApiEndpoint.get("secrets", "/secrets", {
        query: Schema.Struct({ app: Schema.optional(Schema.String) }),
        success: Schema.Struct({ secrets: Schema.Array(SecretMeta), app: Schema.NullOr(Schema.String) }),
        error: [Unauthorized, Forbidden],
      }))
      .add(HttpApiEndpoint.put("putSecret", "/secrets", {
        payload: Schema.Struct({
          reference: Schema.String,
          value: Schema.String,
          app: Schema.optional(Schema.String),
        }),
        success: Schema.Unknown,
        error: [Unauthorized, Forbidden],
      }))
      .add(HttpApiEndpoint["delete"]("deleteSecret", "/secrets", {
        payload: Schema.Struct({
          reference: Schema.String,
          app: Schema.optional(Schema.String),
        }),
        success: Schema.Unknown,
        error: [Unauthorized, Forbidden],
      })),
  );

// --- the client ---------------------------------------------------------------

// A 401 is an expired/missing session regardless of the exact error wrapper the
// Effect client produces. Effect's HttpApiClient surfaces it as an
// HttpClientError whose reason is a DecodeError carrying the response — the
// status lives at `error.reason.response.status`, not `error.response.status` —
// and the tag varies across versions. Match a 401 at any nesting depth.
const hasStatus401 = (value: unknown, depth: number): boolean => {
  if (depth > 4 || typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.status === 401) return true;
  for (const key of ["response", "reason", "error", "cause"]) {
    if (hasStatus401(record[key], depth + 1)) return true;
  }
  return false;
};
export const isSessionExpired = (error: unknown): boolean => hasStatus401(error, 0);

/**
 * The API origin. Same-origin in single-container dev (relative `/`). In the
 * split deployment the GUI is a Cloudflare SPA and the API is at
 * `api.<domain>` — baked in at build time via VITE_API_ORIGIN. The session
 * cookie is scoped `Domain=.<domain>` + SameSite=Lax, so it's sent same-site
 * across subdomains; fetches use `credentials: "include"` to carry it.
 */
const API_ORIGIN: string = (import.meta.env?.VITE_API_ORIGIN as string | undefined) ?? "";

const transport = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    (client): HttpClient.HttpClient =>
      HttpClient.transformResponse(
        Effect.catchIf(
          isSessionExpired,
          () => Effect.fail(new UnauthenticatedError("the session is missing or expired")),
        ),
        // oxlint-disable-next-line typescript/no-explicit-any
      )(client as any) as HttpClient.HttpClient,
  ),
).pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      // "include" carries the cross-subdomain session cookie; "same-origin"
      // would drop it on api.<domain> from platform.<domain>.
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" })),
    ),
  ),
);

const clientPromise = Effect.runPromise(
  Effect.provide(HttpApiClient.make(OpsApi, { baseUrl: API_ORIGIN === "" ? undefined : API_ORIGIN }), transport),
);

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);

export const api = {
  me: () => clientPromise.then((client) => run(client.me())),
  apps: () => clientPromise.then((client) => run(client.apps())),
  directory: () => clientPromise.then((client) => run(client.directory())),
  discover: () => clientPromise.then((client) => run(client.discover())),
  deleteApp: (name: string) => clientPromise.then((client) => run(client.deleteApp({ params: { name } }))),
  scaffold: (name: string) => clientPromise.then((client) => run(client.scaffold({ payload: { name } }))),

  provisioningOptions: () => clientPromise.then((client) => run(client.provisioningOptions())),
  provision: (spec: ProvisionSpec) => clientPromise.then((client) => run(client.provision({ payload: spec }))),
  provisionStatus: (jobId: string) =>
    clientPromise.then((client) => run(client.provisionStatus({ params: { jobId } }))),
  createPreview: (name: string, pr: string) =>
    clientPromise.then((client) => run(client.createPreview({ params: { name }, payload: { pr } }))),
  previews: () => clientPromise.then((client) => run(client.previews())),
  appHistory: (name: string) => clientPromise.then((client) => run(client.appHistory({ params: { name } }))),

  appAcl: (name: string) => clientPromise.then((client) => run(client.appAcl({ params: { name } }))),
  setVisibility: (name: string, visibility: "internal" | "restricted") =>
    clientPromise.then((client) => run(client.setVisibility({ params: { name }, payload: { visibility } }))),
  addAclMember: (name: string, sub: string, role: "admin" | "member") =>
    clientPromise.then((client) => run(client.addAclMember({ params: { name }, payload: { sub, role } }))),
  removeAclMember: (name: string, sub: string) =>
    clientPromise.then((client) => run(client.removeAclMember({ params: { name, sub } }))),

  integrations: () => clientPromise.then((client) => run(client.integrations())),
  createIntegration: (input: { name: string; baseUrl: string; tokenEnv: string }) =>
    clientPromise.then((client) => run(client.createIntegration({ payload: input }))),
  integrationGrants: () => clientPromise.then((client) => run(client.integrationGrants())),
  grantIntegration: (integration: string, app: string) =>
    clientPromise.then((client) => run(client.grantIntegration({ params: { integration }, payload: { app } }))),
  revokeIntegration: (integration: string, app: string) =>
    clientPromise.then((client) => run(client.revokeIntegration({ params: { integration, app } }))),
  integrationAudit: (integration: string) =>
    clientPromise.then((client) => run(client.integrationAudit({ params: { integration } }))),

  providers: () => clientPromise.then((client) => run(client.providers())),
  connections: () => clientPromise.then((client) => run(client.connections())),
  startConnection: (provider: string) =>
    clientPromise.then((client) => run(client.startConnection({ payload: { provider } }))),
  revokeConnection: (connectionId: string) =>
    clientPromise.then((client) => run(client.revokeConnection({ payload: { connectionId } }))),
  grants: () => clientPromise.then((client) => run(client.grants())),
  revokeGrant: (grantId: string) =>
    clientPromise.then((client) => run(client.revokeGrant({ payload: { grantId } }))),

  eventSources: () => clientPromise.then((client) => run(client.eventSources())),
  eventSubscriptions: (opts: { app?: string; source?: string } = {}) =>
    clientPromise.then((client) =>
      run(client.eventSubscriptions({
        query: {
          ...(opts.app === undefined ? {} : { app: opts.app }),
          ...(opts.source === undefined ? {} : { source: opts.source }),
        },
      }))
    ),
  subscribeEvent: (input: { app: string; source: string; eventTypes?: Array<string>; scopes?: Array<string> }) =>
    clientPromise.then((client) => run(client.subscribeEvent({ payload: input }))),
  unsubscribeEvent: (id: string) =>
    clientPromise.then((client) => run(client.unsubscribeEvent({ params: { id } }))),
  eventDeliveries: (opts: { subscriptionId?: string; status?: string } = {}) =>
    clientPromise.then((client) =>
      run(client.eventDeliveries({
        query: {
          ...(opts.subscriptionId === undefined ? {} : { subscriptionId: opts.subscriptionId }),
          ...(opts.status === undefined ? {} : { status: opts.status }),
        },
      }))
    ),

  secrets: (app?: string) =>
    clientPromise.then((client) => run(client.secrets({ query: app === undefined ? {} : { app } }))),
  putSecret: (input: { reference: string; value: string; app?: string }) =>
    clientPromise.then((client) => run(client.putSecret({ payload: input }))),
  deleteSecret: (reference: string, app?: string) =>
    clientPromise.then((client) =>
      run(client.deleteSecret({ payload: app === undefined ? { reference } : { reference, app } }))
    ),
};

/** Start the login: full-page redirect to the API's /auth/login (which 302s to the issuer). */
export const login = () => {
  globalThis.location.assign(`${API_ORIGIN}/auth/login`);
};

export const logout = async () => {
  await fetch(`${API_ORIGIN}/auth/logout`, { method: "POST", credentials: "include", redirect: "manual" });
  globalThis.location.assign("/");
};
