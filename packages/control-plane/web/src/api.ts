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

export const isApiError = (error: unknown): error is ApiError =>
  error instanceof ApiError ||
  (typeof error === "object" && error !== null && (error as { _tag?: string })._tag === "ApiError");

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
});
export type AppRow = typeof AppRow.Type;

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
export type GrantPair = typeof GrantPair.Type;

export const ProviderView = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
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

// The scaffold result has optional/loose fields; keep it typed but permissive.
export const ScaffoldResult = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  audience: Schema.String,
  repoUrl: Schema.String,
  processId: Schema.Number,
});
export type ScaffoldResult = typeof ScaffoldResult.Type;

// --- the typed HttpApi surface -------------------------------------------------

const OpsApi = HttpApi.make("ControlPlane")
  .add(
    HttpApiGroup.make("ops", { topLevel: true })
      .add(HttpApiEndpoint.get("me", "/auth/me", {
        success: Schema.Struct({ actor: Schema.NullOr(Actor), auth: Schema.Literals(["on", "off"]) }),
      }))
      .add(HttpApiEndpoint.get("apps", "/apps", { success: Schema.Struct({ apps: Schema.Array(AppRow) }) }))
      .add(HttpApiEndpoint.get("directory", "/directory", {
        success: Schema.Struct({ apps: Schema.Array(AppRow), tools: Schema.Array(DirectoryTool) }),
      }))
      .add(HttpApiEndpoint.post("discover", "/discover", { success: Schema.Unknown }))
      .add(HttpApiEndpoint["delete"]("deleteApp", "/apps/:name", {
        params: { name: Schema.String },
        success: Schema.Unknown,
      }))
      .add(HttpApiEndpoint.post("scaffold", "/scaffold", {
        payload: Schema.Struct({ name: Schema.String }),
        success: Schema.Unknown,
      })),
  )
  .add(
    HttpApiGroup.make("integrations", { topLevel: true })
      .add(HttpApiEndpoint.get("integrations", "/integrations", {
        success: Schema.Struct({ integrations: Schema.Array(IntegrationView) }),
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
      }))
      .add(HttpApiEndpoint.get("integrationGrants", "/integrations/grants", {
        success: Schema.Struct({ grants: Schema.Array(GrantPair) }),
      }))
      .add(HttpApiEndpoint.post("grantIntegration", "/integrations/:integration/grants", {
        params: { integration: Schema.String },
        payload: Schema.Struct({ app: Schema.String }),
        success: Schema.Unknown,
      }))
      .add(HttpApiEndpoint["delete"]("revokeIntegration", "/integrations/:integration/grants/:app", {
        params: { integration: Schema.String, app: Schema.String },
        success: Schema.Unknown,
      }))
      .add(HttpApiEndpoint.get("integrationAudit", "/integrations/:integration/audit", {
        params: { integration: Schema.String },
        success: Schema.Struct({ audit: Schema.Array(AuditRow) }),
      })),
  )
  .add(
    HttpApiGroup.make("connections", { topLevel: true })
      .add(HttpApiEndpoint.get("providers", "/connections/providers", {
        success: Schema.Struct({ providers: Schema.Array(ProviderView) }),
      }))
      .add(HttpApiEndpoint.get("connections", "/connections", {
        success: Schema.Struct({ connections: Schema.Array(ConnectionView) }),
      }))
      .add(HttpApiEndpoint.post("startConnection", "/connections/start", {
        payload: Schema.Struct({ provider: Schema.String, scopes: Schema.optional(Schema.Array(Schema.String)) }),
        success: Schema.Struct({ authorization_url: Schema.String }),
      }))
      .add(HttpApiEndpoint.post("revokeConnection", "/connections/revoke", {
        payload: Schema.Struct({ connectionId: Schema.String }),
        success: Schema.Unknown,
      }))
      .add(HttpApiEndpoint.get("grants", "/grants", {
        success: Schema.Struct({ grants: Schema.Array(GrantView) }),
      }))
      .add(HttpApiEndpoint.post("revokeGrant", "/grants/revoke", {
        payload: Schema.Struct({ grantId: Schema.String }),
        success: Schema.Unknown,
      })),
  );

// --- the client ---------------------------------------------------------------

// Effect 4.1.5's HttpApiClient fails an undeclared 401 with an
// HttpClientError whose `reason` is a DecodeError carrying the response — the
// status lives at `error.reason.response.status`, not `error.response.status`.
const isSessionExpired = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    _tag?: string;
    reason?: { _tag?: string; response?: { status?: number } };
    response?: { status?: number };
  };
  if (candidate._tag === "ResponseError" && candidate.response?.status === 401) return true;
  if (candidate._tag === "HttpClientError" && candidate.reason?.response?.status === 401) return true;
  return false;
};

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
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" })),
    ),
  ),
);

const clientPromise = Effect.runPromise(
  Effect.provide(HttpApiClient.make(OpsApi), transport),
);

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);

export const api = {
  me: () => clientPromise.then((client) => run(client.me())),
  apps: () => clientPromise.then((client) => run(client.apps())),
  directory: () => clientPromise.then((client) => run(client.directory())),
  discover: () => clientPromise.then((client) => run(client.discover())),
  deleteApp: (name: string) => clientPromise.then((client) => run(client.deleteApp({ params: { name } }))),
  scaffold: (name: string) => clientPromise.then((client) => run(client.scaffold({ payload: { name } }))),

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
};

/** Start the real Logto login: full-page redirect to /auth/login. */
export const login = () => {
  globalThis.location.assign("/auth/login");
};

export const logout = async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin", redirect: "manual" });
  globalThis.location.assign("/");
};
