import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Auth, CurrentActor, requireAuth } from "@terrarium/auth";
import { McpProtocol, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { createServer } from "node:http";
import { Directory, Discovery } from "./discovery/index.ts";
import { AppProxy } from "./gateway/proxy.ts";
import { gatewayRegistrations, syncGatewayTools } from "./gateway/tools.ts";
import { GuiAuth, authFlowRoutes, sessionFromRequest } from "./auth-flow.ts";
import { guiRoutes } from "./gui.ts";
import { integrationRoutes } from "./integrations/routes.ts";
import { SecretsProvider } from "./integrations/secrets.ts";
import { Integrations } from "./integrations/service.ts";
import { bootSecretsReport } from "./secrets/boot.ts";
import { RegisterAppInput, Registry } from "./registry/index.ts";
import { Scaffold, type ScaffoldOptions } from "./scaffold/index.ts";
import { Database } from "./store/database.ts";

export interface ControlPlaneOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly databasePath?: string | undefined;
  readonly discoveryIntervalMs?: number | undefined;
  readonly discoveryTimeoutMs?: number | undefined;
  readonly callTimeoutMs?: number | undefined;
  readonly discoveryToken?: string | undefined;
  /** Gateway → child-app discovery auth via an M2M client credential. */
  readonly discoveryM2M?: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly resource: string;
    readonly scope: string;
  } | undefined;
  readonly scaffold?: ScaffoldOptions | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /**
   * AUTH SEAM: OIDC config for the control plane's own HTTP surfaces (ops
   * routes, scaffold, integration admin, proxy caller auth, whoami). Unset
   * means unauthenticated local-dev mode.
   */
  readonly oidc?: { readonly issuer: string; readonly audience: string } | undefined;
  /** Pre-M2M app credentials for the integration proxy (app name → shared secret). */
  readonly appSecrets?: Readonly<Record<string, string>> | undefined;
  /** Built GUI directory (vite output) served at /. Unset disables the GUI. */
  readonly guiDir?: string | undefined;
  /**
   * Real GUI login (Logto auth-code + PKCE, cookie session). When set, the
   * /auth/* routes are mounted and ops endpoints accept the GUI session cookie
   * in addition to bearer tokens.
   */
  readonly guiAuth?: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly baseUrl: string;
    readonly resource: string;
  } | undefined;
}

export const runDiscoveryAndSync = Effect.gen(function*() {
  const discovery = yield* Discovery;
  const results = yield* discovery.discoverAll();
  yield* syncGatewayTools;
  return results;
});

const hasAwsCredentialsForCheck = () =>
  process.env.AWS_ACCESS_KEY_ID !== undefined ||
  process.env.AWS_PROFILE !== undefined ||
  process.env.AWS_ROLE_ARN !== undefined ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined ||
  process.env.AWS_EC2_METADATA_DISABLED !== "true";

const operationalRoutes = (options: { readonly authEnabled: boolean; readonly guiAuthEnabled: boolean }) =>
  HttpRouter.use((router) =>
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
      // Gate: bearer token (CLI / programmatic) OR the GUI session cookie.
      const gated = options.authEnabled
        ? <E, R>(
            handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
          ): Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            E,
            | Auth
            | HttpServerRequest.HttpServerRequest
            | Exclude<R, CurrentActor>
            | GuiAuth
          > =>
            Effect.gen(function*() {
              if (options.guiAuthEnabled) {
                const session = yield* sessionFromRequest.pipe(Effect.option);
                if (session._tag === "Some" && session.value !== undefined) {
                  return yield* handler.pipe(
                    Effect.provideService(CurrentActor, { sub: session.value.sub, name: session.value.name }),
                  );
                }
              }
              return yield* requireAuth(handler);
            })
        : <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => handler;

      yield* router.add("GET", "/whoami", gated(Effect.gen(function*() {
        const actor = yield* Effect.serviceOption(CurrentActor);
        return yield* HttpServerResponse.json({
          actor: Option.getOrNull(actor),
          auth: options.authEnabled ? "on" : "off",
        });
      })));

      yield* router.add("POST", "/apps", gated(Effect.gen(function*() {
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
      })));

      yield* router.add("GET", "/apps", gated(Effect.gen(function*() {
        const apps = yield* registry.list();
        return yield* HttpServerResponse.json({ apps });
      })));

      yield* router.add("GET", "/directory", gated(Effect.gen(function*() {
        const [apps, tools] = yield* Effect.all([registry.list(), directory.list()]);
        return yield* HttpServerResponse.json({ apps, tools });
      })));

      yield* router.add("POST", "/discover", gated(Effect.gen(function*() {
        const results = yield* discover;
        return yield* HttpServerResponse.json({ results });
      })));
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

/** Mint a client-credentials access token for gateway→child-app discovery. */
const mintClientCredentialsToken = (m2m: NonNullable<ControlPlaneOptions["discoveryM2M"]>) =>
  Effect.gen(function*() {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${m2m.issuer}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: m2m.clientId,
            client_secret: m2m.clientSecret,
            resource: m2m.resource,
            scope: m2m.scope,
          }),
        }).then((r) => r.json() as Promise<{ access_token?: string }>),
      catch: () => new Error("discovery token mint failed"),
    }).pipe(
      Effect.tapError((e) => Effect.logWarning("discovery token mint failed", e)),
      Effect.orElseSucceed(() => ({} as { access_token?: string })),
    );
    const token = response.access_token ?? "";
    if (token === "") yield* Effect.logWarning("discovery token mint returned no access_token");
    return token;
  }).pipe(Effect.orElseSucceed(() => ""));

export const controlPlaneServer = (options: ControlPlaneOptions = {}) => {
  const databaseLayer = options.databasePath === undefined ? Database.layer() : Database.layer(options.databasePath);
  // provideMerge keeps Database in the output context so Integrations.layer can use it too.
  const storeLayer = Layer.mergeAll(Registry.layer, Directory.layer).pipe(Layer.provideMerge(databaseLayer));
  const servicesLayer = Layer.mergeAll(
    Discovery.layer({
      timeoutMs: options.discoveryTimeoutMs ?? 3_000,
      protocol: options.scaffold?.mode === "cloudflare" ? McpProtocol.v2026_07_28 : McpProtocol.v2025_11_25,
      ...options.discoveryM2M !== undefined
        ? { token: mintClientCredentialsToken(options.discoveryM2M) }
        : options.discoveryToken === undefined
          ? {}
          : { headers: { authorization: `Bearer ${options.discoveryToken}` } },
    }),
    AppProxy.layer({ timeoutMs: options.callTimeoutMs ?? 3_000 }),
  ).pipe(
    Layer.provideMerge(storeLayer),
    Layer.provide(
      options.fetch === undefined
        ? FetchHttpClient.layer
        : FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch))),
    ),
  );

  const authEnabled = options.oidc !== undefined || options.guiAuth !== undefined;
  const guiAuthEnabled = options.guiAuth !== undefined;

  // When the GUI login flow is off, provide a stub so route types stay uniform.
  const guiAuthLayer = options.guiAuth === undefined
    ? Layer.succeed(GuiAuth, GuiAuth.of({
        options: { issuer: "", clientId: "", clientSecret: "", baseUrl: "", resource: "" },
        createSession: () => "",
        getSession: () => undefined,
        destroySession: () => {},
        rememberPending: () => {},
        takePending: () => undefined,
      }))
    : GuiAuth.layer(options.guiAuth);

  const routes = Layer.mergeAll(
    gatewayRegistrations,
    operationalRoutes({ authEnabled, guiAuthEnabled }),
    authFlowRoutes,
    Scaffold.routes({ authEnabled }).pipe(Layer.provide(Scaffold.layer(options.scaffold))),
    integrationRoutes({
      authEnabled,
      appSecrets: options.appSecrets ?? {},
    }).pipe(
      Layer.provide(Integrations.layer),
      // SECRETS_PROVIDER=aws|env (default env) — see SECRETS-SPIKE.md
      Layer.provide(Layer.unwrap(Effect.sync(SecretsProvider.layerFromEnv))),
    ),
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

  // The GUI is mounted last: its /* fallback must lose to every API route.
  const allRoutes = Layer.mergeAll(
    routes,
    HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
    // Config provenance for ops/debugging — key NAMES and providers only,
    // never values. Ungated intentionally (same trust level as /health).
    // See SECRETS-SPIKE.md.
    HttpRouter.add("GET", "/config-check", Effect.gen(function*() {
      const keys = [
        ["TERRARIUM_ISSUER", process.env.TERRARIUM_ISSUER],
        ["CONTROL_PLANE_ISSUER", process.env.CONTROL_PLANE_ISSUER],
        ["CONTROL_PLANE_AUDIENCE", process.env.CONTROL_PLANE_AUDIENCE],
        ["GIT_PROVIDER", process.env.GIT_PROVIDER],
        ["GITHUB_APP_ID", process.env.GITHUB_APP_ID],
        ["GITHUB_APP_INSTALLATION_ID", process.env.GITHUB_APP_INSTALLATION_ID],
        ["GITHUB_APP_PRIVATE_KEY", process.env.GITHUB_APP_PRIVATE_KEY],
        ["GITHUB_APP_PRIVATE_KEY_PATH", process.env.GITHUB_APP_PRIVATE_KEY_PATH],
        ["CLOUDFLARE_API_TOKEN", process.env.CLOUDFLARE_API_TOKEN],
        ["CLOUDFLARE_ACCOUNT_ID", process.env.CLOUDFLARE_ACCOUNT_ID],
        ["CLOUDFLARE_ZONE_ID", process.env.CLOUDFLARE_ZONE_ID],
        ["CLOUDFLARE_WORKERS_SUBDOMAIN", process.env.CLOUDFLARE_WORKERS_SUBDOMAIN],
        ["ROUTER_KV_NAMESPACE_ID", process.env.ROUTER_KV_NAMESPACE_ID],
        ["LOGTO_M2M_APP_ID", process.env.LOGTO_M2M_APP_ID],
        ["LOGTO_M2M_APP_SECRET", process.env.LOGTO_M2M_APP_SECRET],
        ["LOGTO_GUI_APP_ID", process.env.LOGTO_GUI_APP_ID],
        ["LOGTO_GUI_APP_SECRET", process.env.LOGTO_GUI_APP_SECRET],
        ["LOGTO_CLI_APP_ID", process.env.LOGTO_CLI_APP_ID],
        ["LOGTO_MCP_RESOURCE", process.env.LOGTO_MCP_RESOURCE],
      ] as const;
      const fromSecrets = new Set(bootSecretsReport.resolved);
      const config: Record<string, { set: boolean; source: string }> = {};
      for (const [name, value] of keys) {
        config[name] = {
          set: value !== undefined,
          source: fromSecrets.has(name)
            ? "aws-secrets-manager"
            : value !== undefined
            ? "env"
            : "unset",
        };
      }
      const body: Record<string, unknown> = {
        secretsProvider: process.env.SECRETS_PROVIDER === "aws" && hasAwsCredentialsForCheck()
          ? "aws"
          : "env",
        resolvedFromSecrets: bootSecretsReport.resolved,
        failedFromSecrets: bootSecretsReport.failed,
        config,
      };
      if (bootSecretsReport.prefix !== undefined) {
        body["secretsPrefix"] = bootSecretsReport.prefix;
      }
      return yield* HttpServerResponse.json(body);
    })),
    guiRoutes(options.guiDir === undefined ? {} : { staticDir: options.guiDir }),
  );

  const authLayer = options.oidc === undefined
    ? Layer.succeed(Auth, Auth.of({
        issuer: "auth-disabled",
        audience: "auth-disabled",
        verify: () => Effect.die("Authentication is disabled"),
        refreshJwks: () => Effect.void,
      }))
    : Auth.layer(options.oidc);

  return Layer.unwrap(
    Effect.map(HttpRouter.toHttpEffect(allRoutes), (app) => HttpServer.serve()(app)),
  ).pipe(
    Layer.provide(authLayer),
    Layer.provide(guiAuthLayer),
    Layer.provideMerge(NodeHttpServer.layer(createServer, {
      port: options.port ?? 0,
      host: options.host ?? "127.0.0.1",
    })),
  ) as Layer.Layer<
    HttpServer.HttpServer,
    import("@terrarium/auth").DiscoveryError | import("effect/http/HttpServerError").ServeError,
    never
  >;
};

/** Build the control plane for the caller's Scope, returning its ephemeral or configured address. */
export const startControlPlane = (options: ControlPlaneOptions = {}) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(controlPlaneServer(options));
    const server = Context.get(context, HttpServer.HttpServer);
    return { url: HttpServer.formatAddress(server.address).replace(/\/$/, "") };
  });
