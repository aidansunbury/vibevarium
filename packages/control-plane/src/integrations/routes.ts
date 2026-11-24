import { Auth, requireAuth, type Actor } from "@vibevarium/auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import { Connections } from "../connections/service.ts";
import { IntegrationError, Integrations } from "./service.ts";

export interface IntegrationRouteOptions {
  /** When false (no OIDC configured), admin routes run unauthenticated (dev only). */
  readonly authEnabled: boolean;
  /** Pre-M2M placeholder app credentials: app name → shared secret. Real app M2M creds arrive with Logto. */
  readonly appSecrets: Readonly<Record<string, string>>;
}

type Response = HttpServerResponse.HttpServerResponse;

/** All bodies passed here are JSON.stringify-safe plain data, so the HttpBodyError channel is unreachable. */
const json = (body: unknown, status = 200): Effect.Effect<Response, never, never> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text("Internal JSON error", { status: 500 })),
  );

const parseJsonBody = Effect.gen(function*() {
  const request = yield* HttpServerRequest;
  return yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
});

const invalidBody = (description: string) =>
  json({ error: "invalid_body", error_description: description }, 400);

type Caller =
  | { readonly kind: "user"; readonly actor: Actor }
  | { readonly kind: "app"; readonly app: string };

/**
 * Caller auth for the proxy: a user bearer token (auth-enabled) or the
 * pre-M2M app-id + shared secret headers.
 */
const resolveCaller = (options: IntegrationRouteOptions) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest;
    const appId = request.headers["x-vibevarium-app"];
    if (typeof appId === "string" && appId.length > 0) {
      const expected = options.appSecrets[appId];
      if (expected === undefined) {
        return yield* Effect.fail(
          yield* json({ error: "invalid_app_credential", error_description: `Unknown app ${appId}` }, 401),
        );
      }
      if (request.headers["x-vibevarium-app-secret"] !== expected) {
        return yield* Effect.fail(
          yield* json({ error: "invalid_app_credential", error_description: `Bad shared secret for app ${appId}` }, 401),
        );
      }
      return { kind: "app", app: appId } satisfies Caller;
    }
    const match = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match || !options.authEnabled) {
      return yield* Effect.fail(
        yield* json({
          error: "invalid_caller",
          error_description: options.authEnabled
            ? "Expected a user bearer token or x-vibevarium-app + x-vibevarium-app-secret headers"
            : "Expected x-vibevarium-app + x-vibevarium-app-secret headers (control-plane auth is disabled)",
        }, 401),
      );
    }
    const auth = yield* Auth;
    const verified = yield* Effect.result(auth.verify(match[1]));
    if (verified._tag === "Failure") {
      return yield* Effect.fail(
        yield* json({ error: "invalid_token", error_description: "Token verification failed" }, 401),
      );
    }
    return { kind: "user", actor: verified.success } satisfies Caller;
  });

/** Wrap an admin handler with requireAuth when OIDC is configured; dev-open otherwise. */
const admin = <R>(
  options: IntegrationRouteOptions,
  handler: Effect.Effect<Response, IntegrationError, R>,
) => {
  const handled = Effect.catch(handler, (error: IntegrationError) =>
    json({ error: error.code, error_description: error.message }, error.status));
  return (options.authEnabled ? requireAuth(handled) : handled) as Effect.Effect<Response, never, unknown>;
};

/**
 * Integration proxy + admin routes (docs/connections.md, proxy model).
 * Grants are app × integration rows; revoke = delete a row. Every proxied
 * call writes a proxy_audit row.
 */
export const integrationRoutes = (options: IntegrationRouteOptions) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const integrations = yield* Integrations;

      // ---- Admin CRUD ----
      yield* router.add("GET", "/integrations", admin(options, Effect.map(integrations.list(), (list) => ({ integrations: list })).pipe(
        Effect.flatMap((value) => json(value)),
      )));

      yield* router.add("POST", "/integrations", admin(options, Effect.gen(function*() {
        const body = yield* parseJsonBody;
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
        if (input === undefined || typeof input.name !== "string" || typeof input.baseUrl !== "string" || typeof input.tokenEnv !== "string") {
          return yield* invalidBody("Expected { name, baseUrl, tokenEnv, authHeader?, timeoutMs? }");
        }
        const created = yield* integrations.create({
          name: input.name,
          baseUrl: input.baseUrl,
          tokenEnv: input.tokenEnv,
          ...(typeof input.authHeader === "string" ? { authHeader: input.authHeader } : {}),
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
        });
        return yield* json(created, 201);
      })));

      yield* router.add("PATCH", "/integrations/:integration", admin(options, Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const body = yield* parseJsonBody;
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
        if (params.integration === undefined || input === undefined) {
          return yield* invalidBody("Expected { baseUrl?, tokenEnv?, authHeader?, timeoutMs? }");
        }
        const updated = yield* integrations.update(params.integration, {
          ...(typeof input.baseUrl === "string" ? { baseUrl: input.baseUrl } : {}),
          ...(typeof input.tokenEnv === "string" ? { tokenEnv: input.tokenEnv } : {}),
          ...(typeof input.authHeader === "string" ? { authHeader: input.authHeader } : {}),
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
        });
        return yield* json(updated);
      })));

      yield* router.add("DELETE", "/integrations/:integration", admin(options, Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        if (params.integration === undefined) return yield* invalidBody("Expected an integration name");
        yield* integrations.remove(params.integration);
        return yield* json({ deleted: params.integration });
      })));

      yield* router.add("GET", "/integrations/grants", admin(options, Effect.gen(function*() {
        return yield* json({ grants: yield* integrations.grants() });
      })));

      yield* router.add("POST", "/integrations/:integration/grants", admin(options, Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const body = yield* parseJsonBody;
        const app = typeof body === "object" && body !== null ? (body as Record<string, unknown>).app : undefined;
        if (params.integration === undefined || typeof app !== "string") {
          return yield* invalidBody("Expected { app }");
        }
        yield* integrations.grant(app, params.integration);
        return yield* json({ app, integration: params.integration, granted: true }, 201);
      })));

      yield* router.add("DELETE", "/integrations/:integration/grants/:app", admin(options, Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        if (params.integration === undefined || params.app === undefined) {
          return yield* invalidBody("Expected an integration and app name");
        }
        yield* integrations.revoke(params.app, params.integration);
        return yield* json({ app: params.app, integration: params.integration, granted: false });
      })));

      yield* router.add("GET", "/integrations/:integration/audit", admin(options, Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const request = yield* HttpServerRequest;
        const limit = Number.parseInt(
          new URL(request.url, "http://cp.local").searchParams.get("limit") ?? "50",
          10,
        );
        return yield* json({
          audit: yield* integrations.audit(params.integration, Number.isInteger(limit) ? limit : 50),
        });
      })));

      // ---- The one proxy: /proxy/:target/* ----
      // A target is either a provider CONNECTION (per-user OAuth credential,
      // checked against the user's grant) or a platform INTEGRATION
      // (company-shared credential, checked against the app grant) — the name
      // registered in oauth_providers wins, then integrations. One mechanism,
      // one audit table (docs/connections.md).
      const connections = yield* Effect.serviceOption(Connections);
      yield* router.add("*", "/proxy/*", Effect.gen(function*() {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://cp.local");
        const match = url.pathname.match(/^\/proxy\/([^/]+)(?:\/(.*))?$/);
        const target = match?.[1];
        if (match === null || target === undefined) {
          return yield* json({ error: "not_found", error_description: "Expected /proxy/:target/*" }, 404);
        }
        const caller = yield* resolveCaller(options).pipe(
          Effect.catch((response: Response) => Effect.succeed({ response })),
        );
        if ("response" in caller) return caller.response;
        const body = yield* request.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))));
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers[name] = value;
        }
        // User-context proxying: the app dimension of the grant check is the app
        // the user is operating, named by header (default "user").
        const onBehalfOf = headers["x-vibevarium-on-behalf-of-app"];
        const app = caller.kind === "app"
          ? caller.app
          : (typeof onBehalfOf === "string" && onBehalfOf.length > 0 ? onBehalfOf : "user");
        const decodedTarget = decodeURIComponent(target);
        const path = match[2] ?? "";
        if (Option.isSome(connections) && (yield* connections.value.isProvider(decodedTarget))) {
          const result = yield* connections.value.proxy({
            appId: app,
            callerKind: caller.kind,
            caller: caller.kind === "user" ? caller.actor.sub : caller.app,
            provider: decodedTarget,
            path,
            query: url.search,
            method: request.method,
            headers,
            body: new Uint8Array(body),
          });
          return HttpServerResponse.uint8Array(result.body, {
            status: result.status,
            headers: result.headers,
          });
        }
        const result = yield* integrations.proxy({
          callerKind: caller.kind,
          caller: caller.kind === "user" ? caller.actor.sub : caller.app,
          app,
          integration: decodedTarget,
          method: request.method,
          path: path + url.search,
          headers,
          body: new Uint8Array(body),
        });
        return HttpServerResponse.uint8Array(result.body, {
          status: result.status,
          headers: result.headers,
        });
      }));
    })
  );
