import { fetchDevToken } from "@terrarium/auth";
import { startDevIssuer } from "@terrarium/dev-issuer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startControlPlane } from "./server.ts";

const AUDIENCE = "https://mcp.terrarium.test";

const mcpInitialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "mcp-gate-test", version: "0.0.1" },
  },
};

const postMcp = (url: string, token?: string) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(mcpInitialize),
  });

describe("meta-MCP gate", () => {
  let issuer: Awaited<ReturnType<typeof startDevIssuer>>;
  let controlPlane: { url: string };
  let scope: Scope.Closeable;

  beforeAll(async () => {
    issuer = await startDevIssuer({ audiences: [AUDIENCE] });
    scope = await Effect.runPromise(Scope.make());
    controlPlane = await Effect.runPromise(
      Effect.provideService(startControlPlane({
        port: 0,
        host: "127.0.0.1",
        databasePath: ":memory:",
        discoveryIntervalMs: 60_000,
        oidc: { issuer: issuer.issuer, audience: AUDIENCE },
      }), Scope.Scope, scope),
    );
  }, 30_000);

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await issuer.close();
  });

  it("401s unauthenticated /mcp with a resource_metadata challenge", async () => {
    const response = await postMcp(controlPlane.url);
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });

  it("serves RFC 9728 protected-resource metadata", async () => {
    const response = await fetch(`${controlPlane.url}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource).toBe(AUDIENCE);
    expect(body.authorization_servers).toEqual([issuer.issuer]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("relays RFC 8414 authorization-server metadata from the issuer", async () => {
    const response = await fetch(`${controlPlane.url}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBe(issuer.issuer);
    expect(body.jwks_uri).toBeTruthy();
  });

  it("rejects a token for the wrong audience", async () => {
    const wrong = await startDevIssuer({ audiences: ["https://other.example.com"] });
    try {
      const token = await Effect.runPromise(
        fetchDevToken({ issuer: wrong.issuer, sub: "mallory", audience: "https://other.example.com" }),
      );
      const response = await postMcp(controlPlane.url, token.access_token);
      expect(response.status).toBe(401);
    } finally {
      await wrong.close();
    }
  });

  it("passes a valid bearer through to the MCP transport", async () => {
    const token = await Effect.runPromise(
      fetchDevToken({ issuer: issuer.issuer, sub: "ada", audience: AUDIENCE, name: "Ada" }),
    );
    const response = await postMcp(controlPlane.url, token.access_token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.serverInfo.name).toBe("terrarium-meta-mcp");
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });
});
