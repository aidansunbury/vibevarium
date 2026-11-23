import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { McpProtocol, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Auth, authConfigFromEnv, CurrentActor, requireAuth } from "./auth.ts";
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

// AUTH SEAM: off by default. Deploy with TERRARIUM_ISSUER set (and optionally
// TERRARIUM_AUDIENCE) to require a bearer token on every API surface. The SPA
// discovers the mode from the public /auth/status route. When Logto is live,
// only the two env values change.
const issuer = process.env.TERRARIUM_ISSUER;
const audience = process.env.TERRARIUM_AUDIENCE;
const platformAudience = process.env.TERRARIUM_PLATFORM_AUDIENCE;

/** Paths that always run through the Worker instead of the asset layer. */
const workerFirstPaths = [
  "/OpenTicket",
  "/CloseTicket",
  "/TicketById/*",
  "/TicketList/*",
  "/openapi.json",
  "/rpc*",
  "/mcp*",
  "/whoami",
  "/auth/*",
  "/health",
  "/d1-health",
];

export default class TicketsWorker extends Cloudflare.Worker<TicketsWorker>()(
  "TicketsWorker",
  {
    name: process.env.WORKER_NAME ?? "terrarium-tickets-cloudflare",
    main: import.meta.url,
    domain: process.env.APP_HOSTNAME === undefined
      ? null
      : {
          name: process.env.APP_HOSTNAME,
          // Zone for the hostname's base domain. Defaults to vibevarium.com;
          // forks override via CLOUDFLARE_ZONE_ID.
          zoneId: process.env.CLOUDFLARE_ZONE_ID ?? "c6ae3b555628f3c6c0fb3883c479dcc4",
        },
    // The React SPA, built by vite into web/dist. API paths run worker-first;
    // everything else serves assets, with SPA fallback for client-side routes.
    assets: {
      directory: "./web/dist",
      runWorkerFirst: workerFirstPaths,
      notFoundHandling: "single-page-application",
    },
    env: issuer === undefined
      ? {}
      : {
        TERRARIUM_ISSUER: issuer,
        ...(audience === undefined ? {} : { TERRARIUM_AUDIENCE: audience }),
        ...(platformAudience === undefined ? {} : { TERRARIUM_PLATFORM_AUDIENCE: platformAudience }),
      },
  },
  Effect.gen(function*() {
    const ticketsApi = yield* TicketsApi;
    const database = yield* Cloudflare.D1.QueryDatabase(yield* TicketsDatabase);
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    const authConfig = authConfigFromEnv(env);
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

    // Build the Auth service once per isolate when auth is on: it fetches the
    // issuer's discovery document and holds a cached JWKS client.
    const authContext = authConfig === undefined
      ? undefined
      : Context.make(Auth, Context.get(yield* Layer.build(Auth.layer(authConfig)), Auth));

    /**
     * Wrap an API surface with auth when it is on. requireAuth needs Auth in
     * the environment; the pre-built context provides it per request without
     * re-fetching discovery. The surfaces only require what the worker
     * request scope already provides (HttpServerRequest, Scope).
     */
    const protect = <E, R>(
      surface: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) =>
      authContext === undefined
        ? surface
        : requireAuth(surface).pipe(Effect.provide(authContext));

    const whoami = Effect.gen(function*() {
      const actor = yield* Effect.serviceOption(CurrentActor);
      return yield* HttpServerResponse.json({
        actor: Option.getOrNull(actor),
        auth: authConfig === undefined ? "off" : "on",
      });
    });

    return {
      fetch: Effect.gen(function*() {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://tickets.local").pathname;

        // Public operational + discovery routes.
        if (path === "/health") return HttpServerResponse.text("ok");
        if (path === "/auth/status") {
          return yield* HttpServerResponse.json({
            enabled: authConfig !== undefined,
            ...(authConfig === undefined ? {} : { issuer: authConfig.issuer }),
          });
        }
        if (path === "/d1-health") {
          const row = yield* database.prepare(
            "SELECT value FROM app_metadata WHERE key = 'surface'",
          ).all<{ value: string }>();
          return yield* HttpServerResponse.json({ d1: "bound", rows: row.results });
        }

        if (path === "/whoami") return yield* protect(Effect.orDie(whoami));
        if (path.startsWith("/mcp")) return yield* protect(Effect.orDie(mcp));
        if (path === "/rpc" || path.startsWith("/rpc/")) return yield* protect(Effect.orDie(ticketsApi.fetch));
        return yield* protect(Effect.orDie(http));
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    Effect.provide(TicketsLive),
    Effect.orDie,
  ),
) {}
