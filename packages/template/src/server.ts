import * as Domain from "@alchemy.run/domain";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { McpProtocol, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
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
  HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
).pipe(Layer.provide(TicketsModelLive));

// AUTH SEAM: add the shared @terrarium/auth HTTP middleware around the final
// router effect (and, where needed, Domain command/view middleware) here.
// MCP's default header forwarding will then present the caller's credentials.
export const ticketsServer = (port = 0) =>
  Layer.unwrap(
    Effect.map(HttpRouter.toHttpEffect(Routes), (app) => HttpServer.serve()(app)),
  ).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" }),
    ),
  );

/** Build a server for the lifetime of the caller's Scope, on an ephemeral port by default. */
export const startTicketsServer = (port = 0) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(ticketsServer(port));
    const server = Context.get(context, HttpServer.HttpServer);
    return { url: HttpServer.formatAddress(server.address).replace(/\/$/, "") };
  });
