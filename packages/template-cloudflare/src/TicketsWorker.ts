import * as Redacted from "effect/Redacted";
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
import {
  AuthFlow,
  authFlowConfigFromEnv,
  callbackRoute,
  loginRoute,
  logoutRoute,
  meRoute,
} from "./auth-flow.ts";
import { eventsSecretFromEnv, platformHookRoute } from "./hooks.ts";
import { TicketsApi } from "./TicketsApi.api.ts";
import { TicketsModel } from "./Tickets.model.ts";
import { TicketsHttp, TicketsMcp } from "./surfaces.ts";

export const TicketsDatabase = Cloudflare.D1.Database("TicketsDatabase", {
  name: process.env.D1_DATABASE_NAME ?? "vibevarium-tickets-cloudflare-data",
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
// TERRARIUM_AUDIENCE / TERRARIUM_PLATFORM_AUDIENCE) to require a credential on
// every API surface — a platform/own-audience bearer, or the session cookie
// from the auth-code + PKCE flow (src/auth-flow.ts, on when
// TERRARIUM_CLIENT_ID/SECRET are set). Unauthenticated: API requests get 401
// + WWW-Authenticate, HTML requests get 302 → /auth/login. The SPA discovers
// the mode from the public /auth/status route.
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
  "/hooks/*",
];

export default class TicketsWorker extends Cloudflare.Worker<TicketsWorker>()(
  "TicketsWorker",
  {
    name: process.env.WORKER_NAME ?? "vibevarium-tickets-cloudflare",
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
    // NOTE: page loads (`GET /`) are served by the asset layer and never run
    // this Worker, so the no-logged-out-state guarantee is enforced
    // client-side: the SPA's first act is `/auth/me`, which 401s without a
    // session and bounces the browser to `/auth/login` (302 to the provider).
    // Worker-first API routes additionally 302 HTML requests to /auth/login.
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
        // The per-app OIDC client (Traditional web) that powers the SPA's
        // auth-code + PKCE login. The scaffold's Logto auto-registration
        // provides these (id via deployer env, secret as a worker secret —
        // never in source). Unset → the session flow is off and only bearer
        // auth applies.
        ...(process.env.TERRARIUM_CLIENT_ID === undefined
          ? {}
          : { TERRARIUM_CLIENT_ID: process.env.TERRARIUM_CLIENT_ID }),
        ...(process.env.TERRARIUM_CLIENT_SECRET === undefined
          ? {}
          : { TERRARIUM_CLIENT_SECRET: process.env.TERRARIUM_CLIENT_SECRET }),
        ...(process.env.TERRARIUM_M2M_CLIENT_ID === undefined
          ? {}
          : { TERRARIUM_M2M_CLIENT_ID: process.env.TERRARIUM_M2M_CLIENT_ID }),
        ...(process.env.TERRARIUM_M2M_CLIENT_SECRET === undefined
          ? {}
          : { TERRARIUM_M2M_CLIENT_SECRET: Redacted.make(process.env.TERRARIUM_M2M_CLIENT_SECRET) }),
        // Platform event delivery secret (docs/internal/events.md): the control plane
        // signs each /hooks/platform delivery with it. Provisioned by the
        // scaffold; unset → the events seam is off.
        ...(process.env.TERRARIUM_EVENTS_SECRET === undefined
          ? {}
          : { TERRARIUM_EVENTS_SECRET: process.env.TERRARIUM_EVENTS_SECRET }),
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

    // The session login flow (auth-code + PKCE, signed-cookie sessions) is on
    // only when the per-app OIDC client is configured alongside the issuer.
    const flowConfig = authFlowConfigFromEnv(env as Record<string, unknown>);
    const flowService = flowConfig === undefined ? undefined : AuthFlow.make(flowConfig);

    // The events seam (docs/internal/events.md): /hooks/platform receives platform-
    // signed event deliveries when the app has subscriptions. Off unless the
    // scaffold provisioned TERRARIUM_EVENTS_SECRET.
    const eventsSecret = eventsSecretFromEnv(env as Record<string, unknown>);

    /**
     * Wrap an API surface with auth when it is on. requireAuth needs Auth (and
     * optionally AuthFlow for session-cookie support) in the environment; the
     * pre-built context provides them per request without re-fetching
     * discovery. The surfaces only require what the worker request scope
     * already provides (HttpServerRequest, Scope).
     */
    const protect = <E, R, EX = never>(
      surface: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | EX>,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, CurrentActor> | EX> => {
      if (authContext === undefined) return surface as Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, CurrentActor> | EX>;
      const authed = requireAuth(surface);
      const provided = flowService === undefined
        ? authed.pipe(Effect.provide(authContext))
        : authed.pipe(
          Effect.provideService(AuthFlow, flowService),
          Effect.provide(authContext),
        );
      return provided as Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, CurrentActor> | EX>;
    };

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
        // Platform event delivery (docs/internal/events.md): platform-signed, not
        // user-auth — the signature authenticates the control plane. The app
        // authorizes what it does with each verified event.
        if (path === "/hooks/platform") {
          return yield* platformHookRoute(eventsSecret, (_envelope) => Effect.void).pipe(Effect.orDie);
        }
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

        // Session login flow (auth-code + PKCE). Public by design: these
        // routes ARE the way a user authenticates. Never wrapped by
        // requireAuth — that would be a redirect loop. AuthFlow is fully
        // provided here, so the routes' declared requirement is satisfied.
        if (flowService !== undefined) {
          if (path === "/auth/login") return yield* loginRoute.pipe(Effect.provideService(AuthFlow, flowService), Effect.orDie);
          if (path === "/auth/callback") {
            return yield* callbackRoute.pipe(Effect.provideService(AuthFlow, flowService), Effect.orDie);
          }
          if (path === "/auth/logout") {
            return yield* logoutRoute.pipe(Effect.provideService(AuthFlow, flowService), Effect.orDie);
          }
          if (path === "/auth/me") return yield* meRoute.pipe(Effect.provideService(AuthFlow, flowService), Effect.orDie);
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
