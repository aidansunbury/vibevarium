/**
 * The meta-MCP gate (docs/auth.md "DCR: the meta-MCP forcing function",
 * docs/state-of-the-project.md next step #1).
 *
 * The public MCP surface at `/mcp` is a first-class OAuth-protected MCP
 * server in the Linear/Railway shape:
 *
 *   - No/invalid bearer → `401` with `WWW-Authenticate: Bearer
 *     resource_metadata="<baseUrl>/.well-known/oauth-protected-resource"`
 *     (RFC 9728) — this is what arbitrary MCP clients (Claude, Cursor,
 *     Executor) follow to discover the authorization server.
 *   - Valid bearer (verified by the control plane's `Auth` service: JWKS from
 *     the configured issuer — Casdoor under `TERRARIUM_AUTH_PROVIDER=casdoor`,
 *     WorkOS AuthKit under `TERRARIUM_AUTH_PROVIDER=workos` — and the platform
 *     audience, Option B′) → forwarded to the internal MCP endpoint at
 *     {@link MCP_INTERNAL_PATH}.
 *
 * The Effect MCP transport stays mounted at {@link MCP_INTERNAL_PATH}, which
 * has no public route and is only reachable through this gate. The GUI and
 * ops routes keep their existing session/bearer gates; this file only covers
 * `/mcp` and the OAuth discovery documents.
 *
 * Discovery documents (public, per the MCP auth spec):
 *   - `/.well-known/oauth-protected-resource` — this resource's id +
 *     `authorization_servers` pointing at the issuer.
 *   - `/.well-known/oauth-authorization-server` — a relay of the issuer's own
 *     metadata (OIDC discovery or RFC 8414), for clients that expect the AS
 *     document on the resource host.
 */
import { Auth, CurrentActor } from "@terrarium/auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** Internal-only mount for the Effect MCP transport; not routed publicly. */
export const MCP_INTERNAL_PATH = "/__mcp-internal";

export interface McpGateOptions {
  /** Public origin of this control plane (https://platform.vibevarium.com). */
  readonly baseUrl: string;
  /** The platform resource indicator (audience), e.g. https://mcp.vibevarium.com. */
  readonly resource: string;
  /** Whether the gate is on (auth configured). Off → unauthenticated local dev. */
  readonly authEnabled: boolean;
}

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const unauthorized = (resourceMetadataUrl: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "invalid_token", error_description: "Expected an Authorization: Bearer token" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
      },
    },
  );

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(request.text, (text) => ({ hasBody: text.length > 0, text }));

/**
 * The origin to forward gated requests to. The server's own bound address is
 * always right; the configured public baseUrl can point at a proxy (Caddy)
 * that isn't listening in tests/local.
 */
const selfOrigin = Effect.map(
  HttpServer.addressFormattedWith((address) => Effect.succeed(address.replace(/\/$/, ""))),
  (address) => address,
);

const forwardToInternalMcp = (
  options: { readonly baseUrl: string },
  token: string | undefined,
) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = yield* selfOrigin;
    // Effect's Node server normalizes request.url to pathname+search in some
    // versions; reconstruct defensively so the forward never loses the path.
    const path = request.originalUrl ?? request.url;
    const url = new URL(MCP_INTERNAL_PATH + (path.includes("?") ? path.slice(path.indexOf("?")) : ""), origin);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!hopByHopHeaders.has(name) && name !== "authorization") {
        headers[name] = value;
      }
    }
    if (token !== undefined) {
      headers["authorization"] = `Bearer ${token}`;
    }
    const body = yield* readBody(request);
    const upstream = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: request.method,
          headers,
          ...(body.hasBody ? { body: body.text } : {}),
        }),
      catch: (cause) =>
        new Error(`MCP upstream fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    });
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!hopByHopHeaders.has(name)) {
        responseHeaders[name] = value;
      }
    });
    const responseBody = yield* Effect.tryPromise({
      try: () => upstream.text(),
      catch: () => new Error("Could not read MCP upstream response"),
    });
    return HttpServerResponse.text(responseBody, {
      status: upstream.status,
      headers: responseHeaders,
    });
  });

/**
 * The `/mcp` route: bearer-gated pass-through to the internal MCP endpoint.
 * The verified actor lands on `CurrentActor` for downstream handlers.
 */
export const mcpGateRoute = (options: McpGateOptions) =>
  HttpRouter.add("*", "/mcp", Effect.gen(function*() {
    if (!options.authEnabled) {
      // Local dev: no auth configured — proxy straight through (no bearer).
      return yield* forwardToInternalMcp(options, undefined);
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const match = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      return unauthorized(`${options.baseUrl}/.well-known/oauth-protected-resource`);
    }
    const auth = yield* Auth;
    return yield* auth.verify(match[1]).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(unauthorized(`${options.baseUrl}/.well-known/oauth-protected-resource`)),
        onSuccess: (actor) =>
          forwardToInternalMcp(options, match[1]).pipe(
            Effect.provideService(CurrentActor, actor),
            Effect.catch((error) =>
              Effect.gen(function*() {
                yield* Effect.logWarning("MCP gate forward failed", { error: String(error) });
                return HttpServerResponse.text("MCP upstream unavailable", { status: 502 });
              }),
            ),
          ),
      }),
    );
  }));

/** RFC 9728 Protected Resource Metadata — public, unauthenticated. */
export const protectedResourceMetadataRoute = (options: McpGateOptions & { readonly issuer: string | undefined }) =>
  HttpRouter.add("GET", "/.well-known/oauth-protected-resource", Effect.succeed(
    HttpServerResponse.jsonUnsafe({
      resource: options.resource,
      ...(options.issuer === undefined ? {} : { authorization_servers: [options.issuer] }),
      bearer_methods_supported: ["header"],
    }),
  ));

/**
 * RFC 8414 Authorization Server Metadata, relayed from the issuer's discovery
 * document so clients that only check the resource host can proceed. Public.
 */
export const authorizationServerMetadataRoute = (options: McpGateOptions & { readonly issuer: string | undefined }) =>
  HttpRouter.add("GET", "/.well-known/oauth-authorization-server", Effect.gen(function*() {
    if (options.issuer === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: "authorization_server_unknown", error_description: "No authorization server is configured" },
        { status: 404 },
      );
    }
    const candidates = [
      `${options.issuer}/.well-known/oauth-authorization-server`,
      `${options.issuer}/.well-known/openid-configuration`,
    ];
    for (const candidate of candidates) {
      const response = yield* Effect.tryPromise({
        try: () => fetch(candidate),
        catch: () => new Error("fetch failed"),
      }).pipe(Effect.option);
      if (Option.isSome(response) && response.value.ok) {
        const json = yield* Effect.tryPromise({
          try: () => response.value.json(),
          catch: () => new Error("invalid JSON"),
        }).pipe(Effect.option);
        if (Option.isSome(json)) {
          return HttpServerResponse.jsonUnsafe(json.value, {
            headers: { "cache-control": "public, max-age=300" },
          });
        }
      }
    }
    return HttpServerResponse.jsonUnsafe(
      { error: "authorization_server_unreachable", error_description: `Could not relay metadata from ${options.issuer}` },
      { status: 502 },
    );
  }));

/** All gate routes, merged into the router before the GUI's catch-all. */
export const mcpGateRoutes = (options: McpGateOptions & { readonly issuer: string | undefined }) =>
  Layer.mergeAll(
    mcpGateRoute(options),
    protectedResourceMetadataRoute(options),
    authorizationServerMetadataRoute(options),
  );
