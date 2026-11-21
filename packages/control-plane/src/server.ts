import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { McpProtocol, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { createServer } from "node:http";
import { Directory, Discovery } from "./discovery/index.ts";
import { AppProxy } from "./gateway/proxy.ts";
import { gatewayRegistrations, syncGatewayTools } from "./gateway/tools.ts";
import { RegisterAppInput, Registry } from "./registry/index.ts";
import { Database } from "./store/database.ts";

export interface ControlPlaneOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly databasePath?: string | undefined;
  readonly discoveryIntervalMs?: number | undefined;
  readonly discoveryTimeoutMs?: number | undefined;
  readonly callTimeoutMs?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export const runDiscoveryAndSync = Effect.gen(function*() {
  const discovery = yield* Discovery;
  const results = yield* discovery.discoverAll();
  yield* syncGatewayTools;
  return results;
});

const operationalRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const registry = yield* Registry;
    const directory = yield* Directory;
    const discovery = yield* Discovery;
    const proxy = yield* AppProxy;
    const mcpServer = yield* McpServer.McpServer;
    const context = Context.make(Registry, registry).pipe(
      Context.add(Directory, directory),
      Context.add(Discovery, discovery),
      Context.add(AppProxy, proxy),
      Context.add(McpServer.McpServer, mcpServer),
    );
    const discover = Effect.provideContext(runDiscoveryAndSync, context);

    yield* router.add("POST", "/apps", Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
      const decoded = yield* Schema.decodeUnknownEffect(RegisterAppInput)(body).pipe(Effect.result);
      if (Result.isFailure(decoded)) {
        return yield* HttpServerResponse.json({
          error: "Invalid app registration; expected a lower-kebab-case name and an http(s) MCP URL",
          details: decoded.failure.message,
        }, { status: 400 });
      }
      const app = yield* registry.register(decoded.success);
      return yield* HttpServerResponse.json(app, { status: 201 });
    }));

    yield* router.add("GET", "/directory", Effect.gen(function*() {
      const [apps, tools] = yield* Effect.all([registry.list(), directory.list()]);
      return yield* HttpServerResponse.json({ apps, tools });
    }));

    yield* router.add("POST", "/discover", Effect.gen(function*() {
      const results = yield* discover;
      return yield* HttpServerResponse.json({ results });
    }));
  })
);

const scheduledDiscovery = (intervalMs: number) =>
  Layer.effectDiscard(Effect.gen(function*() {
    if (intervalMs <= 0) return;
    yield* runDiscoveryAndSync.pipe(
      Effect.repeat(Schedule.spaced(intervalMs)),
      Effect.forkScoped,
    );
  }));

export const controlPlaneServer = (options: ControlPlaneOptions = {}) => {
  const databaseLayer = options.databasePath === undefined ? Database.layer() : Database.layer(options.databasePath);
  const storeLayer = Layer.mergeAll(Registry.layer, Directory.layer).pipe(Layer.provide(databaseLayer));
  const servicesLayer = Layer.mergeAll(
    Discovery.layer({ timeoutMs: options.discoveryTimeoutMs ?? 3_000 }),
    AppProxy.layer({ timeoutMs: options.callTimeoutMs ?? 3_000 }),
  ).pipe(
    Layer.provideMerge(storeLayer),
    Layer.provide(
      options.fetch === undefined
        ? FetchHttpClient.layer
        : FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch))),
    ),
  );

  const routes = Layer.mergeAll(
    gatewayRegistrations,
    operationalRoutes,
    scheduledDiscovery(options.discoveryIntervalMs ?? 30_000),
  ).pipe(
    Layer.provide(McpServer.layerHttp({
      name: "terrarium-meta-mcp",
      version: "0.0.1",
      path: "/mcp",
      protocols: [McpProtocol.v2025_11_25],
    })),
    Layer.provide(servicesLayer),
  );

  const allRoutes = Layer.mergeAll(
    routes,
    HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
  );

  return Layer.unwrap(
    Effect.map(HttpRouter.toHttpEffect(allRoutes), (app) => HttpServer.serve()(app)),
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, {
      port: options.port ?? 0,
      host: options.host ?? "127.0.0.1",
    })),
  );
};

/** Build the control plane for the caller's Scope, returning its ephemeral or configured address. */
export const startControlPlane = (options: ControlPlaneOptions = {}) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(controlPlaneServer(options));
    const server = Context.get(context, HttpServer.HttpServer);
    return { url: HttpServer.formatAddress(server.address).replace(/\/$/, "") };
  });
