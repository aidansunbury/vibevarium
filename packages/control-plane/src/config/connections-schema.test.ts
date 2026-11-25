import { describe, expect, it } from "vitest";
import { connectionsConfig } from "./connections.config.ts";
import { validateConnectionsConfig } from "./connections-schema.ts";

const empty = {
  secrets: {},
  oauthProviders: {},
  proxiedSecrets: {},
  webhooks: {},
  webhookDeliverySecrets: {},
};

describe("connections config validation", () => {
  it("accepts the deployed catalog", () => {
    expect(validateConnectionsConfig(connectionsConfig)).toEqual(connectionsConfig);
  });

  it("rejects dangling credential slugs before startup", () => {
    expect(() => validateConnectionsConfig({
      ...empty,
      secrets: {},
      proxiedSecrets: {
        openai: { displayName: "OpenAI", baseUrl: "https://api.openai.com", secret: "missing" },
      },
    })).toThrow('proxiedSecrets.openai.secret references unknown secret slug "missing"');
  });

  it("rejects dangling webhook delivery mappings", () => {
    expect(() => validateConnectionsConfig({
      ...empty,
      webhookDeliverySecrets: { "my-app": "missing" },
    })).toThrow('webhookDeliverySecrets.my-app references unknown secret slug "missing"');
  });

  it("rejects proxy target collisions and invalid timeouts", () => {
    const oauthProviders = {
      shared: {
        displayName: "Shared",
        authorizeUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        userinfoUrl: "https://example.com/user",
        apiBaseUrl: "https://example.com",
        clientIdRef: "CLIENT_ID",
        clientSecret: "secret",
        defaultScopes: [],
      },
    };
    const proxiedSecrets = {
      shared: { displayName: "Shared", baseUrl: "https://example.com", secret: "secret", timeoutMs: 0 },
    };
    expect(() => validateConnectionsConfig({
      ...empty,
      secrets: { secret: { ref: "SECRET" } },
      oauthTokenEncryption: "secret",
      oauthProviders,
      proxiedSecrets,
    })).toThrow('"shared" cannot be both an OAuth provider and a proxied secret');
    expect(() => validateConnectionsConfig({
      ...empty,
      secrets: { secret: { ref: "SECRET" } },
      proxiedSecrets,
    })).toThrow("timeoutMs must be a positive integer");
  });

  it("does not treat prototype properties as configured secrets", () => {
    expect(() => validateConnectionsConfig({
      ...empty,
      proxiedSecrets: {
        constructor: { displayName: "Legacy", baseUrl: "https://example.com", secret: "constructor" },
      },
    })).toThrow('references unknown secret slug "constructor"');
  });

  it("rejects malformed provider URLs during startup validation", () => {
    expect(() => validateConnectionsConfig({
      ...empty,
      secrets: { token: { ref: "TOKEN" } },
      proxiedSecrets: {
        bad: { displayName: "Bad", baseUrl: "https://?", secret: "token" },
      },
    })).toThrow("must be a valid absolute http(s) URL");
  });

  it("accepts local and remote logo URLs", () => {
    const config = validateConnectionsConfig({
      ...empty,
      secrets: { token: { ref: "TOKEN" } },
      proxiedSecrets: {
        local: { displayName: "Local", logoUrl: "/provider-logos/local.svg", baseUrl: "https://example.com", secret: "token" },
        remote: { displayName: "Remote", logoUrl: "https://example.com/logo.svg", baseUrl: "https://example.com", secret: "token" },
      },
    });
    expect(config.proxiedSecrets.local?.logoUrl).toBe("/provider-logos/local.svg");
    expect(config.proxiedSecrets.remote?.logoUrl).toBe("https://example.com/logo.svg");
  });
});
