import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { controlPlaneServer } from "./server.ts";
import { loadBootSecrets } from "./secrets/boot.ts";
import { PlatformConfigService } from "./config/index.ts";

// SECRETS_PROVIDER=aws: resolve runtime config (GITHUB_APP_*, CLOUDFLARE_API_TOKEN,
// LOGTO_*, DATABASE_URL) from Secrets Manager into process.env before the
// config layer parses it. No-op for env mode (default) — local dev is
// unchanged. See SECRETS-SPIKE.md + DB-SPIKE.md.
await loadBootSecrets();

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// Parse + validate the whole runtime config once (src/config/index.ts): every
// env var is declared there, typed, defaulted; a bad value fails the boot with
// one ConfigError instead of a silent undefined deep in a handler.
import { loadPlatformConfig } from "./config/index.ts";
const config = await Effect.runPromise(loadPlatformConfig);

const server = Layer.effectDiscard(HttpServer.logAddress).pipe(
  Layer.provideMerge(controlPlaneServer({
    port: config.port,
    host: config.host,
    // DATABASE_URL (prod: RDS postgres://…, injected from SM at boot) wins;
    // DATABASE_PATH remains the PGlite local-dev fallback. See DB-SPIKE.md.
    databaseUrl: config.databaseUrl,
    databasePath: config.databasePath,
    discoveryIntervalMs: config.discoveryIntervalMs,
    discoveryTimeoutMs: config.discoveryTimeoutMs,
    callTimeoutMs: config.callTimeoutMs,
    discoveryToken: config.discoveryToken,
    // Gateway → child-app MCP discovery auth (M2M client credentials in prod,
    // static DISCOVERY_TOKEN placeholder locally).
    ...(config.discoveryM2M === undefined ? {} : { discoveryM2M: config.discoveryM2M }),
    ...(config.oidc === undefined ? {} : { oidc: config.oidc }),
    ...(config.guiAuth === undefined ? {} : { guiAuth: config.guiAuth }),
    appSecrets: config.appSecrets,
    guiDir: config.guiDir ?? join(packageRoot, "web", "dist"),
    scaffold: {
      issuer: config.issuer,
      appsRoot: config.appsRoot,
      startupTimeoutMs: config.startupTimeoutMs,
      mode: config.github !== undefined ? "cloudflare" : "local",
      ...(config.github === undefined
        ? {}
        : {
            github: {
              appId: config.github.appId,
              ...(config.github.privateKeyPath === undefined
                ? { privateKey: config.github.privateKey ?? "" }
                : { privateKeyPath: config.github.privateKeyPath }),
              installationId: config.github.installationId,
              org: config.github.org,
            },
          }),
      ...(config.cloudflare === undefined
        ? {}
        : {
            cloudflare: {
              accountId: config.cloudflare.accountId,
              alchemyHome: config.cloudflare.alchemyHome,
              workersSubdomain: config.cloudflare.workersSubdomain,
              domain: config.domain,
              routerNamespaceId: config.cloudflare.routerNamespaceId,
              zoneId: config.cloudflare.zoneId,
            },
          }),
      ...(config.logto === undefined ? {} : { logto: config.logto }),
    },
  })),
);

NodeRuntime.runMain(Layer.launch(server));
