import * as Domain from "@alchemy.run/domain";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Auth, CurrentActor, requireAuth, type AuthConfig } from "@terrarium/auth";
import { McpProtocol, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createServer } from "node:http";
import { TicketsApi } from "./TicketsApi.api.ts";
import { TicketsModel } from "./Tickets.model.ts";
import { TicketsHttp, TicketsMcp } from "./surfaces.ts";

export const TicketsModelLive = TicketsModel.layer(Layer.empty).pipe(
  Layer.provide(Domain.InMemory),
);

const RpcRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const api = yield* TicketsApi;
    yield* router.add("*", "/rpc", api.fetch);
  }),
);

const WhoAmiRoute = HttpRouter.add(
  "GET",
  "/whoami",
  Effect.gen(function* () {
    const actor = yield* Effect.serviceOption(CurrentActor);
    return yield* HttpServerResponse.json({
      actor: Option.getOrNull(actor),
      auth: Option.isSome(actor) ? "on" : "off",
    });
  }),
);

const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(TicketsHttp.api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(TicketsHttp.layer),
  ),
  TicketsMcp.pipe(
    Layer.provide(
      McpServer.layerHttp({
        name: "tickets",
        version: "0.0.1",
        path: "/mcp",
        protocols: [McpProtocol.v2025_11_25],
      }),
    ),
  ),
  RpcRoute,
  WhoAmiRoute,
  HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
).pipe(Layer.provide(TicketsModelLive));

export interface TicketsServerOptions {
  readonly appName?: string | undefined;
  readonly auth?: AuthConfig | false | undefined;
}

const authConfigFromEnv = (appName: string, configured: TicketsServerOptions["auth"]) => {
  if (configured === false) return undefined;
  if (configured !== undefined) return configured;
  const mode = process.env.TERRARIUM_AUTH;
  const issuer = process.env.TERRARIUM_ISSUER;
  if (mode === "off" || (mode === undefined && issuer === undefined)) return undefined;
  if (issuer === undefined || issuer.length === 0) {
    throw new Error("TERRARIUM_ISSUER is required when TERRARIUM_AUTH is on");
  }
  return {
    issuer,
    audience: process.env.TERRARIUM_AUDIENCE ?? `${appName}.terrarium.local`,
  } satisfies AuthConfig;
};

/** Protect every application surface while leaving liveness checks public. */
const withOptionalAuth = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  auth: AuthConfig | undefined,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (auth === undefined || new URL(request.url, "http://tickets.local").pathname === "/health") {
      return yield* app;
    }
    return yield* requireAuth(app);
  });

const disabledAuth = Layer.succeed(Auth, Auth.of({
  issuer: "auth-disabled",
  audience: "auth-disabled",
  verify: () => Effect.die("Authentication is disabled"),
  refreshJwks: () => Effect.void,
}));

// AUTH SEAM: the shared OIDC middleware wraps the final router effect. MCP's
// header forwarding therefore carries the same caller credentials to this check.
export const ticketsServer = (port = 0, options: TicketsServerOptions = {}) => {
  const appName = options.appName ?? process.env.APP_NAME ?? "tickets";
  const auth = authConfigFromEnv(appName, options.auth);
  const appLayer = Layer.unwrap(
    Effect.map(HttpRouter.toHttpEffect(Routes), (app) =>
      HttpServer.serve()(withOptionalAuth(app, auth))),
  );
  return appLayer.pipe(
    Layer.provide(auth === undefined ? disabledAuth : Auth.layer(auth)),
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" }),
    ),
  );
};

/** Build a server for the lifetime of the caller's Scope, on an ephemeral port by default. */
export const startTicketsServer = (port = 0, options: TicketsServerOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(ticketsServer(port, options));
    const server = Context.get(context, HttpServer.HttpServer);
    return { url: HttpServer.formatAddress(server.address).replace(/\/$/, "") };
  }).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause))));

/** Run the standalone app; generated apps only need this wrapper around the shared server. */
export const runTicketsServer = (options: TicketsServerOptions & { readonly port?: number } = {}) => {
  const port = options.port ?? Number.parseInt(process.env.PORT ?? "3000", 10);
  const ServerWithAddressLog = Layer.effectDiscard(HttpServer.logAddress).pipe(
    Layer.provideMerge(ticketsServer(port, options)),
  );
  NodeRuntime.runMain(Layer.launch(ServerWithAddressLog));
};
