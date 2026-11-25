import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlane } from "../server.ts";
import type { ConnectionsConfig } from "../config/connections-schema.ts";

const config = {
  secrets: {
    "snowflake-token": { ref: "SNOWFLAKE_TOKEN" },
  },
  oauthProviders: {},
  proxiedSecrets: {
    snowflake: {
      displayName: "Snowflake",
      logoUrl: "https://example.com/snowflake.svg",
      baseUrl: "https://api.example.com",
      secret: "snowflake-token",
      authHeader: "authorization_bearer",
    },
  },
  webhooks: {},
  webhookDeliverySecrets: {},
} satisfies ConnectionsConfig;

const scopes: Array<Scope.Closeable> = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  delete process.env.SNOWFLAKE_TOKEN;
});

const start = async () => {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const controlPlane = await Effect.runPromise(Effect.provideService(startControlPlane({
    port: 0,
    host: "127.0.0.1",
    databasePath: ":memory:",
    discoveryIntervalMs: 0,
    connectionsConfig: config,
    appSecrets: { "test-app": "app-secret" },
  }), Scope.Scope, scope));
  return controlPlane;
};

describe("static proxied-secret definitions", () => {
  it("lists config metadata and rejects runtime definition creation", async () => {
    process.env.SNOWFLAKE_TOKEN = "token";
    const controlPlane = await start();

    const list = await (await fetch(`${controlPlane.url}/integrations`)).json();
    expect(list.integrations).toHaveLength(1);
    expect(list.integrations[0]).toMatchObject({
      name: "snowflake",
      displayName: "Snowflake",
      logoUrl: "https://example.com/snowflake.svg",
      secret: "snowflake-token",
      tokenConfigured: true,
    });

    const created = await fetch(`${controlPlane.url}/integrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "other", baseUrl: "https://other.example.com", tokenEnv: "OTHER_SECRET" }),
    });
    expect(created.status).toBe(404);
  });

  it("does not proxy unconfigured legacy integration rows", async () => {
    const controlPlane = await start();
    const created = await fetch(`${controlPlane.url}/integrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "legacy", baseUrl: "https://legacy.example.com", tokenEnv: "SNOWFLAKE_TOKEN" }),
    });
    expect(created.status).toBe(404);

    const response = await fetch(`${controlPlane.url}/proxy/legacy/status`, {
      headers: { "x-vibevarium-app": "test-app", "x-vibevarium-app-secret": "app-secret" },
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("unknown_integration");
  });

  it("rejects platform-secret mutation and requires an app scope", async () => {
    const controlPlane = await start();
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await fetch(`${controlPlane.url}/secrets`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ reference: "token", value: "value" }) }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("app_required");
    }
  });
});
