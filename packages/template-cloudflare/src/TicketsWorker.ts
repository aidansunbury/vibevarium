import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { McpProtocol, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { TicketsApi } from "./TicketsApi.api.ts";
import { TicketsModel } from "./Tickets.model.ts";
import { TicketsHttp, TicketsMcp } from "./surfaces.ts";

export const TicketsDatabase = Cloudflare.D1.Database("TicketsDatabase", {
  name: process.env.D1_DATABASE_NAME ?? "terrarium-tickets-cloudflare-data",
  migrations: "./migrations",
});

const TicketsLive = TicketsModel.layer(Layer.empty).pipe(
  Layer.provide(
    Layer.mergeAll(
      DomainCloudflare.layerDurableObjects(),
      Cloudflare.D1.QueryDatabaseBinding,
    ),
  ),
);

export default class TicketsWorker extends Cloudflare.Worker<TicketsWorker>()(
  "TicketsWorker",
  {
    name: process.env.WORKER_NAME ?? "terrarium-tickets-cloudflare",
    main: import.meta.url,
    domain: process.env.APP_HOSTNAME === undefined
      ? null
      : { name: process.env.APP_HOSTNAME, zoneId: "15d5d22954d28f66f4e141a1668df477" },
  },
  Effect.gen(function*() {
    const ticketsApi = yield* TicketsApi;
    const database = yield* Cloudflare.D1.QueryDatabase(yield* TicketsDatabase);
    const http = yield* HttpApiBuilder.layer(TicketsHttp.api, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(TicketsHttp.layer),
      Layer.provide([HttpPlatform.layer, Etag.layer]),
      HttpRouter.toHttpEffect,
    );
    const mcp = yield* TicketsMcp.pipe(
      Layer.provide(McpServer.layerHttpRequestScoped({
        name: "tickets",
        version: "0.0.1",
        path: "/mcp",
        protocols: [McpProtocol.v2026_07_28],
      })),
      HttpRouter.toHttpEffect,
    );

    return {
      fetch: Effect.gen(function*() {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://tickets.local").pathname;
        if (path === "/health") return HttpServerResponse.text("ok");
        if (path === "/d1-health") {
          const row = yield* database.prepare(
            "SELECT value FROM app_metadata WHERE key = 'surface'",
          ).all<{ value: string }>();
          return yield* HttpServerResponse.json({ d1: "bound", rows: row.results });
        }
        if (path.startsWith("/mcp")) return yield* mcp;
        if (path === "/rpc") return yield* ticketsApi.fetch;
        return yield* http;
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    Effect.provide(TicketsLive),
    Effect.orDie,
  ),
) {}
