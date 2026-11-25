import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { loadPlatformConfig } from "./config/index.ts";

const ENV_KEYS = [
  "TERRARIUM_AUTH_PROVIDER",
  "TERRARIUM_CONNECTION_PROVIDERS",
  "TERRARIUM_DEPLOY_TARGETS",
  "GIT_PROVIDER",
  "GUI_APP_ID",
  "GUI_APP_SECRET",
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "DISCOVERY_CLIENT_ID",
  "DISCOVERY_CLIENT_SECRET",
  "CONNECTIONS_TOKEN_ENCRYPTION_KEY",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "LINEAR_OAUTH_CLIENT_ID",
  "LINEAR_OAUTH_CLIENT_SECRET",
] as const;

type EnvOverrides = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

const BASE_ENV = {
  TERRARIUM_AUTH_PROVIDER: "casdoor",
  TERRARIUM_CONNECTION_PROVIDERS: "",
  TERRARIUM_DEPLOY_TARGETS: "",
  GIT_PROVIDER: "local",
  GUI_APP_ID: "gui-client",
  GUI_APP_SECRET: "gui-secret",
  CLOUDFLARE_API_TOKEN: "cloudflare-token",
} satisfies EnvOverrides;

const withEnv = async <A>(overrides: EnvOverrides, run: () => Promise<A>): Promise<A> => {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const load = () => Effect.runPromise(Effect.result(loadPlatformConfig.pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...process.env })),
)));

const expectConfigError = async (overrides: EnvOverrides) => {
  const result = await withEnv(overrides, load);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Success") throw new Error("Expected config validation to fail");
  return JSON.stringify(result.failure);
};

describe("configuration-dependent required secrets", () => {
  it("does not require credentials for disabled connection providers", async () => {
    const result = await withEnv({}, load);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success.connectionProviders).toEqual([]);
  });

  it("requires only the enabled GitHub provider's credentials and token encryption", async () => {
    const error = await expectConfigError({ TERRARIUM_CONNECTION_PROVIDERS: "github" });
    expect(error).toContain("GitHub OAuth connection");
    expect(error).toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(error).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(error).toContain("CONNECTIONS_TOKEN_ENCRYPTION_KEY");
    expect(error).not.toContain("LINEAR_OAUTH_CLIENT_ID");
  });

  it("requires only the enabled Linear provider's credentials and token encryption", async () => {
    const error = await expectConfigError({ TERRARIUM_CONNECTION_PROVIDERS: "linear" });
    expect(error).toContain("Linear OAuth connection");
    expect(error).toContain("LINEAR_OAUTH_CLIENT_ID");
    expect(error).toContain("LINEAR_OAUTH_CLIENT_SECRET");
    expect(error).toContain("CONNECTIONS_TOKEN_ENCRYPTION_KEY");
    expect(error).not.toContain("GITHUB_OAUTH_CLIENT_ID");
  });

  it("accepts a fully configured set of enabled providers", async () => {
    const result = await withEnv({
      TERRARIUM_CONNECTION_PROVIDERS: "github,linear",
      CONNECTIONS_TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      GITHUB_OAUTH_CLIENT_ID: "github-id",
      GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
      LINEAR_OAUTH_CLIENT_ID: "linear-id",
      LINEAR_OAUTH_CLIENT_SECRET: "linear-secret",
    }, load);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success.connectionProviders).toEqual(["github", "linear"]);
  });

  it("requires Cloudflare credentials only when its deploy target is enabled", async () => {
    const error = await expectConfigError({ TERRARIUM_DEPLOY_TARGETS: "cloudflare", CLOUDFLARE_API_TOKEN: undefined });
    expect(error).toContain("Cloudflare deploy target");
    expect(error).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("requires WorkOS credentials only when WorkOS auth is enabled", async () => {
    const error = await expectConfigError({ TERRARIUM_AUTH_PROVIDER: "workos" });
    expect(error).toContain("WorkOS auth");
    expect(error).toContain("WORKOS_CLIENT_ID");
    expect(error).toContain("WORKOS_API_KEY");
    expect(error).not.toContain("GUI_APP_SECRET");
  });

  it("allows the GitHub App private key to come from a file instead of a secret", async () => {
    const result = await withEnv({
      GIT_PROVIDER: "github",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY_PATH: "/run/secrets/github-app-key.pem",
    }, load);
    expect(result._tag).toBe("Success");
  });
});
