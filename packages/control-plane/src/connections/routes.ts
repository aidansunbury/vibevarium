import { Auth } from "@vibevarium/auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { authenticatedApp, delegatedUser } from "../app-auth.ts";
import { GuiAuth, SessionRefreshError, sessionFromRequest, sessionRefreshErrorResponse } from "../auth-flow.ts";
import { Registry } from "../registry/index.ts";
import { ConnectionError, Connections } from "./service.ts";

export interface ConnectionsRouteOptions {
  readonly authEnabled: boolean;
  readonly guiAuthEnabled: boolean;
  /** Local development credentials, enabled when OIDC is off. */
  readonly appSecrets: Readonly<Record<string, string>>;
}

type Response = HttpServerResponse.HttpServerResponse;

const json = (body: unknown, status = 200): Effect.Effect<Response, never, never> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text("Internal JSON error", { status: 500 })),
  );

const errorJson = (error: ConnectionError) =>
  json({
    error: error.code,
    error_description: error.message,
    ...error.details,
  }, error.status);

/** Recover from ConnectionError into its JSON response; usable with .pipe on any failing Effect. */
const catchConnection = <A, R>(self: Effect.Effect<A, ConnectionError, R>): Effect.Effect<A | Response, never, R> =>
  self.pipe(Effect.catch((error: ConnectionError) => errorJson(error)));

const catchSessionRefresh = <E, R>(
  self: Effect.Effect<Response, E | SessionRefreshError, R>,
): Effect.Effect<Response, E, R> =>
  self.pipe(Effect.catchIf(
    (error): error is SessionRefreshError => error instanceof SessionRefreshError,
    () => Effect.succeed(sessionRefreshErrorResponse()),
  ));

const parseJsonBody = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
});

const bodyRecord = (body: unknown): Record<string, unknown> | undefined =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;

const stringList = (value: unknown): ReadonlyArray<string> | undefined => {
  if (Array.isArray(value)) {
    const scopes = value.filter((scope): scope is string => typeof scope === "string");
    return scopes;
  }
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return undefined;
};

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Vibevarium</title>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f8f8f6; color: #1c1917; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  main { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 2rem; max-width: 28rem; width: calc(100% - 2rem); box-shadow: 0 1px 3px rgb(0 0 0 / 0.06); }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0; line-height: 1.5; color: #44403c; }
  .scopes { display: flex; gap: 0.375rem; flex-wrap: wrap; margin: 0.75rem 0; }
  .scope { background: #f5f5f4; border: 1px solid #e7e5e4; border-radius: 999px; padding: 0.125rem 0.625rem; font-size: 0.8rem; font-family: ui-monospace, monospace; }
  .account { font-size: 0.9rem; color: #78716c; }
  form { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  button { flex: 1; border-radius: 8px; padding: 0.625rem 1rem; font-size: 0.95rem; font-weight: 500; cursor: pointer; border: 1px solid transparent; }
  button[value="approve"] { background: #1c1917; color: #fff; }
  button[value="deny"] { background: #fff; border-color: #d6d3d1; color: #44403c; }
  .error { color: #b91c1c; }
  a { color: #1c1917; }
  .dashboard-link { display: inline-block; margin-top: 1rem; border-radius: 8px; padding: 0.625rem 1rem; background: #1c1917; color: #fff; font-size: 0.95rem; font-weight: 500; text-decoration: none; }
</style></head><body><main>${body}</main></body></html>`;

const htmlResponse = (markup: string, status = 200) =>
  HttpServerResponse.text(markup, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * The consent session: the GUI session cookie when present, else (bearer-auth
 * deployments) a verified bearer actor. The consent screen REQUIRES an actor —
 * there is no anonymous path to a decision.
 */
const consentActor = Effect.gen(function*() {
  const session = yield* sessionFromRequest;
  if (session !== undefined) return { sub: session.sub, name: session.name };
  const request = yield* HttpServerRequest.HttpServerRequest;
  const match = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) return undefined;
  const auth = yield* Auth;
  const verified = yield* Effect.result(auth.verify(match[1]));
  return verified._tag === "Success" ? { sub: verified.success.sub, name: verified.success.name ?? verified.success.sub } : undefined;
});

export const connectionRoutes = (options: ConnectionsRouteOptions) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const connections = yield* Connections;
      const registry = yield* Registry;

      // ---- User routes: GUI session cookie (or bearer fallback) ----

      const userGate = <E, R>(
        handler: (actor: { readonly sub: string; readonly name: string }) => Effect.Effect<Response, E, R>,
      ): Effect.Effect<Response, E, R | HttpServerRequest.HttpServerRequest | GuiAuth | Auth> =>
        Effect.gen(function*() {
          const actor = yield* consentActor;
          if (actor === undefined) {
            return yield* json({
              error: "session_required",
              error_description: options.guiAuthEnabled
                ? "Sign in to the control plane (the GUI session cookie) to manage connections"
                : "Expected a user bearer token",
            }, 401);
          }
          return yield* handler(actor);
        }).pipe(catchSessionRefresh);

      yield* router.add("GET", "/connections/providers", userGate(() =>
        Effect.gen(function*() {
          const providers = yield* connections.listProviders();
          return yield* json({ providers });
        }).pipe(catchConnection)));

      yield* router.add("GET", "/connections", userGate((actor) =>
        Effect.gen(function*() {
          return yield* json({ connections: yield* connections.listConnections(actor.sub) });
        }).pipe(catchConnection)));

      yield* router.add("POST", "/connections/start", userGate((actor) =>
        Effect.gen(function*() {
          const body = bodyRecord(yield* parseJsonBody);
          if (body === undefined || typeof body.provider !== "string") {
            return yield* json({ error: "invalid_body", error_description: "Expected { provider, scopes? }" }, 400);
          }
          const started = yield* connections.startConnection(actor.sub, body.provider, stringList(body.scopes));
          return yield* json(started);
        }).pipe(catchConnection)));

      const callbackHandler = Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://cp.local");
        const body = request.method === "POST"
          ? yield* request.text.pipe(Effect.catch(() => Effect.succeed("")))
          : "";
        const params = request.method === "POST" ? new URLSearchParams(body) : url.searchParams;
        const accept = request.headers.accept ?? "";
        const guiAuth = yield* GuiAuth;
        const guiOrigin = (guiAuth.options.guiOrigin ?? guiAuth.options.baseUrl).replace(/\/+$/, "");
        const dashboardLink = `<p><a class="dashboard-link" href="${escapeHtml(guiOrigin === "" ? "/" : `${guiOrigin}/`)}">Back to dashboard</a></p>`;
        return yield* connections.completeConnection(params).pipe(
          Effect.map((connection) =>
            accept.includes("text/html")
              ? htmlResponse(page("Connected", `
<h1>Connected ${escapeHtml(connection.provider)}</h1>
<p>Account: <strong>${escapeHtml(connection.provider_account.label)}</strong></p>
<p>You can close this tab and return to the app.</p>${dashboardLink}`))
              : HttpServerResponse.jsonUnsafe(connection, { status: 200 })
          ),
          Effect.catch((error: ConnectionError) =>
            accept.includes("text/html")
              ? Effect.succeed(htmlResponse(page("Connection failed", `<h1>Connection failed</h1><p class="error">${escapeHtml(error.message)}</p>${dashboardLink}`), error.status))
              : errorJson(error)
          ),
        );
      });
      yield* router.add("GET", "/connections/callback", callbackHandler);
      yield* router.add("POST", "/connections/callback", callbackHandler);

      yield* router.add("POST", "/connections/revoke", userGate((actor) =>
        Effect.gen(function*() {
          const body = bodyRecord(yield* parseJsonBody);
          if (body === undefined || typeof body.connectionId !== "string") {
            return yield* json({ error: "invalid_body", error_description: "Expected { connectionId }" }, 400);
          }
          return yield* json(yield* connections.revokeConnection(actor.sub, body.connectionId));
        }).pipe(catchConnection)));

      // ---- Grant consent (user-facing, server-rendered) ----

      yield* router.add("GET", "/grants/consent", Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const grantId = new URL(request.url, "http://cp.local").searchParams.get("grant") ?? "";
        const actor = yield* consentActor;
        if (actor === undefined) {
          // The app sent the user here but they are not signed in — send them
          // through the GUI login first when it's configured.
          if (options.guiAuthEnabled) {
            return HttpServerResponse.empty({
              status: 302,
              headers: { location: `/auth/login?returnTo=${encodeURIComponent(`/grants/consent?grant=${grantId}`)}` },
            });
          }
          return yield* json({ error: "session_required", error_description: "Sign in to approve this grant" }, 401);
        }
        return yield* connections.consentView(actor.sub, grantId).pipe(
          Effect.map((view) => {
            const scopes = view.grant.scopes.split(/\s+/).filter(Boolean);
            return htmlResponse(page("Connection consent", `
<h1>Connection consent</h1>
<p><strong>App ${escapeHtml(view.grant.appId)}</strong> wants your <strong>${escapeHtml(view.provider.displayName)}</strong>:</p>
<div class="scopes">${scopes.map((scope) => `<span class="scope">${escapeHtml(scope)}</span>`).join("")}</div>
<p class="account">Connected account: ${escapeHtml(view.connection.providerAccountLabel)}<br>Signed in as: ${escapeHtml(actor.name)}</p>
<form method="post" action="/grants/decision">
<input type="hidden" name="grant" value="${escapeHtml(view.grant.id)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`));
          }),
          Effect.catch((error: ConnectionError) => {
            if (error.code === "connection_required") {
              const provider = typeof error.details?.provider === "string" ? error.details.provider : "";
              return Effect.succeed(htmlResponse(page("Connect first", `
<h1>Connect your account first</h1>
<p class="error">${escapeHtml(error.message)}</p>
<form method="post" action="/connections/start-form">
<input type="hidden" name="provider" value="${escapeHtml(provider)}">
<button type="submit" value="connect" style="background:#1c1917;color:#fff">Connect ${escapeHtml(provider)}</button>
</form>`), error.status));
            }
            return Effect.succeed(htmlResponse(page("Grant error", `<h1>Grant error</h1><p class="error">${escapeHtml(error.message)}</p>`), error.status));
          }),
        );
      }).pipe(catchSessionRefresh));

      // Convenience: the consent screen's "connect first" button posts here,
      // which starts the provider flow and redirects to the provider.
      yield* router.add("POST", "/connections/start-form", Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const actor = yield* consentActor;
        if (actor === undefined) return yield* json({ error: "session_required", error_description: "Sign in first" }, 401);
        const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
        const provider = new URLSearchParams(body).get("provider") ?? "";
        return yield* connections.startConnection(actor.sub, provider, undefined).pipe(
          Effect.map((started) =>
            HttpServerResponse.empty({ status: 303, headers: { location: started.authorization_url } })
          ),
          Effect.catch((error: ConnectionError) =>
            Effect.succeed(htmlResponse(page("Connect failed", `<h1>Connect failed</h1><p class="error">${escapeHtml(error.message)}</p>`), error.status))
          ),
        );
      }).pipe(catchSessionRefresh));

      const decisionHandler = Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const actor = yield* consentActor;
        if (actor === undefined) return yield* json({ error: "session_required", error_description: "Sign in to decide this grant" }, 401);
        const text = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
        const form = new URLSearchParams(text);
        const grantId = form.get("grant") ?? "";
        const decision = form.get("decision") ?? "";
        if (decision !== "approve" && decision !== "deny") {
          return yield* json({ error: "invalid_decision", error_description: "decision must be approve or deny" }, 400);
        }
        const accept = request.headers.accept ?? "";
        return yield* connections.decideGrant(actor.sub, grantId, decision).pipe(
          Effect.map((result) => {
            if (accept.includes("application/json")) {
              return HttpServerResponse.jsonUnsafe(result, { status: 200 });
            }
            return result.status === "denied"
              ? htmlResponse(page("Denied", `<h1>Grant denied</h1><p>The app was not granted access.</p>`))
              : htmlResponse(page("Approved", `
<h1>Grant approved</h1>
<p data-grant-id="${escapeHtml(result.grant.grant_id)}">The app can now use your connection. You can close this tab.</p>`));
          }),
          Effect.catch((error: ConnectionError) =>
            accept.includes("application/json")
              ? errorJson(error)
              : Effect.succeed(htmlResponse(page("Grant error", `<h1>Grant error</h1><p class="error">${escapeHtml(error.message)}</p>`), error.status))
          ),
        );
      }).pipe(catchSessionRefresh);
      yield* router.add("POST", "/grants/decision", decisionHandler);

      yield* router.add("GET", "/grants", userGate((actor) =>
        Effect.gen(function*() {
          return yield* json({ grants: yield* connections.listGrants({ ownerSub: actor.sub }) });
        }).pipe(catchConnection)));

      yield* router.add("POST", "/grants/revoke", userGate((actor) =>
        Effect.gen(function*() {
          const body = bodyRecord(yield* parseJsonBody);
          if (body === undefined || typeof body.grantId !== "string") {
            return yield* json({ error: "invalid_body", error_description: "Expected { grantId }" }, 400);
          }
          return yield* json(yield* connections.revokeGrant(actor.sub, body.grantId));
        }).pipe(catchConnection)));

      const appRoute = <R>(handler: (appId: string) => Effect.Effect<Response, never, R>) =>
        Effect.gen(function*() {
          const appId = yield* authenticatedApp(options, registry);
          if (appId === undefined) {
            return yield* json({ error: "invalid_app_credential", error_description: "Expected valid app credentials" }, 401);
          }
          return yield* handler(appId);
        });

      yield* router.add("POST", "/grants/request", appRoute((appId) =>
        Effect.gen(function*() {
          const body = bodyRecord(yield* parseJsonBody);
          if (body === undefined || typeof body.provider !== "string") {
            return yield* json({ error: "invalid_body", error_description: "Expected { appId?, provider, scopes }" }, 400);
          }
          if (body.appId !== undefined && body.appId !== appId) {
            return yield* json({ error: "app_mismatch", error_description: "Body appId does not match the authenticated app" }, 403);
          }
          const scopes = stringList(body.scopes) ?? [];
          const grant = yield* connections.requestGrant(appId, body.provider, scopes);
          return yield* json(grant, 201);
        }).pipe(catchConnection)));

      yield* router.add("GET", "/grants/for-app", appRoute((appId) =>
        Effect.gen(function*() {
          return yield* json({ grants: yield* connections.listGrants({ appId }) });
        }).pipe(catchConnection)));

      yield* router.add("POST", "/vend", appRoute((appId) =>
        Effect.gen(function*() {
          const body = bodyRecord(yield* parseJsonBody);
          if (body === undefined || typeof body.provider !== "string") {
            return yield* json({ error: "invalid_body", error_description: "Expected { provider }" }, 400);
          }
          if (body.appId !== undefined && body.appId !== appId) {
            return yield* json({ error: "app_mismatch", error_description: "Body appId does not match the authenticated app" }, 403);
          }
          const user = options.authEnabled ? yield* delegatedUser : undefined;
          if (options.authEnabled && user === undefined) {
            return yield* json({ error: "invalid_user_credential", error_description: "Expected a user access token" }, 401);
          }
          return yield* json(yield* connections.vend(appId, body.provider, user?.sub));
        }).pipe(catchConnection)));

      // NOTE: there is deliberately NO connections-specific proxy route here.
      // The ONE proxy is the integrations module's `/proxy/:target/*`, which
      // dispatches to a provider connection (per-user OAuth credential) or a
      // platform integration (company-shared credential) by registration kind —
      // see docs/connections.md "one mechanism covers both".
    }),
  );
