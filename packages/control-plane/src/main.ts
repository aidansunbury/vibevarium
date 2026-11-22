import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { controlPlaneServer } from "./server.ts";
import { loadBootSecrets } from "./secrets/boot.ts";

// SECRETS_PROVIDER=aws: resolve runtime config (GITHUB_APP_*, CLOUDFLARE_API_TOKEN,
// LOGTO_*) from Secrets Manager into process.env before any config is read.
// No-op for env mode (default) — local dev is unchanged. See SECRETS-SPIKE.md.
await loadBootSecrets();

const integerEnv = (name: string, fallback: number) => {
  const value = process.env[name];
  return value === undefined ? fallback : Number.parseInt(value, 10);
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** App M2M placeholder credentials: APP_SECRETS='{"tickets":"s3cret"}' (or APP_SECRET_<name> env vars). */
const appSecrets = (): Record<string, string> => {
  const fromJson = process.env.APP_SECRETS;
  if (fromJson !== undefined) {
    try {
      return JSON.parse(fromJson) as Record<string, string>;
    } catch {
      throw new Error("APP_SECRETS must be a JSON object mapping app names to shared secrets");
    }
  }
  const collected: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("APP_SECRET_") && value !== undefined) {
      collected[name.slice("APP_SECRET_".length).toLowerCase().replaceAll("_", "-")] = value;
    }
  }
  return collected;
};

const oidc = process.env.CONTROL_PLANE_ISSUER === undefined
  ? undefined
  : {
      issuer: process.env.CONTROL_PLANE_ISSUER,
      audience: process.env.CONTROL_PLANE_AUDIENCE ?? "control.terrarium.local",
    };

// Real GUI login (Logto auth-code + PKCE). Enabled when the GUI app secret is
// present. Locally the secret comes from the repo-root .env; in production it
// is AWS Secrets Manager /terrarium/prod/logto-gui-app-secret.
const guiAuth = process.env.LOGTO_GUI_APP_SECRET === undefined
  ? undefined
  : {
      issuer: (process.env.LOGTO_ISSUER ?? "https://auth.vibevarium.com/oidc").replace(/\/+$/, ""),
      clientId: process.env.LOGTO_GUI_APP_ID ?? "s9ne7qecvf20vktab5iwl",
      clientSecret: process.env.LOGTO_GUI_APP_SECRET,
      baseUrl: (process.env.CONTROL_PLANE_BASE_URL ?? `http://127.0.0.1:${integerEnv("PORT", 4100)}`).replace(/\/+$/, ""),
      resource: process.env.PLATFORM_OIDC_AUDIENCE ?? "https://mcp.vibevarium.com",
    };

const server = Layer.effectDiscard(HttpServer.logAddress).pipe(
  Layer.provideMerge(controlPlaneServer({
    port: integerEnv("PORT", 4100),
    host: process.env.HOST ?? "127.0.0.1",
    databasePath: process.env.DATABASE_PATH,
    discoveryIntervalMs: integerEnv("DISCOVERY_INTERVAL_MS", 30_000),
    discoveryTimeoutMs: integerEnv("DISCOVERY_TIMEOUT_MS", 3_000),
    callTimeoutMs: integerEnv("CALL_TIMEOUT_MS", 3_000),
    discoveryToken: process.env.DISCOVERY_TOKEN,
    ...(oidc === undefined ? {} : { oidc }),
    ...(guiAuth === undefined ? {} : { guiAuth }),
    appSecrets: appSecrets(),
    guiDir: process.env.GUI_DIR ?? join(packageRoot, "web", "dist"),
    scaffold: {
      issuer: process.env.TERRARIUM_ISSUER,
      appsRoot: process.env.TERRARIUM_APPS_ROOT,
      startupTimeoutMs: integerEnv("APP_START_TIMEOUT_MS", 20_000),
      mode: process.env.GIT_PROVIDER === "github" ? "cloudflare" : "local",
      github: process.env.GIT_PROVIDER === "github"
        ? {
            appId: process.env.GITHUB_APP_ID!,
            // Secrets mode delivers the PEM inline (GITHUB_APP_PRIVATE_KEY);
            // env mode points at a file (GITHUB_APP_PRIVATE_KEY_PATH).
            ...(process.env.GITHUB_APP_PRIVATE_KEY_PATH === undefined
              ? { privateKey: process.env.GITHUB_APP_PRIVATE_KEY! }
              : { privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH }),
            installationId: Number(process.env.GITHUB_APP_INSTALLATION_ID),
            org: process.env.GITHUB_ORG ?? "terrarium-sandbox",
          }
        : undefined,
      cloudflare: process.env.CLOUDFLARE_ACCOUNT_ID === undefined
        ? undefined
        : {
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
            alchemyHome: process.env.ALCHEMY_HOME!,
            workersSubdomain: process.env.CLOUDFLARE_WORKERS_SUBDOMAIN!,
            routerNamespaceId: process.env.ROUTER_KV_NAMESPACE_ID!,
            zoneId: process.env.CLOUDFLARE_ZONE_ID!,
          },
    },
  })),
);

NodeRuntime.runMain(Layer.launch(server));
