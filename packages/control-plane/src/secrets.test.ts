import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { SecretsProvider } from "./integrations/secrets.ts";
import { AWS_BOOT_SECRETS } from "./secrets/boot.ts";

describe("secret source configuration", () => {
  it("uses identical UPPER_SNAKE_CASE names in Secrets Manager and process.env", () => {
    for (const [secretName, envName] of Object.entries(AWS_BOOT_SECRETS)) {
      expect(secretName).toBe(envName);
      expect(secretName).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(AWS_BOOT_SECRETS).toMatchObject({
      GITHUB_OAUTH_CLIENT_ID: "GITHUB_OAUTH_CLIENT_ID",
      GITHUB_OAUTH_CLIENT_SECRET: "GITHUB_OAUTH_CLIENT_SECRET",
      LINEAR_OAUTH_CLIENT_ID: "LINEAR_OAUTH_CLIENT_ID",
      LINEAR_OAUTH_CLIENT_SECRET: "LINEAR_OAUTH_CLIENT_SECRET",
      CONNECTIONS_TOKEN_ENCRYPTION_KEY: "CONNECTIONS_TOKEN_ENCRYPTION_KEY",
      SESSION_ENCRYPTION_KEY: "SESSION_ENCRYPTION_KEY",
    });
  });

  it("prefers boot-injected or explicitly overridden environment values in AWS mode", async () => {
    const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "VIBEVARIUM_TEST_SECRET"] as const;
    const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.VIBEVARIUM_TEST_SECRET = "from-environment";
    try {
      const value = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(SecretsProvider.awsLayer({
          prefix: "/vibevarium/test/",
          region: "us-east-1",
        }));
        const secrets = Context.get(context, SecretsProvider);
        return yield* secrets.resolve("VIBEVARIUM_TEST_SECRET");
      })));
      expect(Option.getOrUndefined(value)).toBe("from-environment");
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
