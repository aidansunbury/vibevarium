import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import { startControlPlane } from "../server.ts";

describe("connection callback pages", () => {
  it("links back to the configured dashboard after a provider error", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const previousKey = process.env.SESSION_ENCRYPTION_KEY;
    process.env.SESSION_ENCRYPTION_KEY = "connection-route-test-session-key";
    try {
      const controlPlane = await Effect.runPromise(
        Effect.provideService(startControlPlane({
          port: 0,
          host: "127.0.0.1",
          databasePath: ":memory:",
          discoveryIntervalMs: 60_000,
          guiAuth: {
            issuer: "https://auth.vibevarium.test",
            clientId: "test-client",
            clientSecret: "test-secret",
            baseUrl: "https://api.vibevarium.test",
            guiOrigin: "https://platform.vibevarium.test/",
            resource: "https://api.vibevarium.test/mcp",
          },
        }), Scope.Scope, scope),
      );

      const response = await fetch(`${controlPlane.url}/connections/callback?error=access_denied`, {
        headers: { accept: "text/html" },
      });
      const body = await response.text();

      expect(response.status).toBe(400);
      expect(body).toContain("Connection failed");
      expect(body).toContain(">Back to dashboard</a>");
      expect(body).toContain('href="https://platform.vibevarium.test/"');
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      if (previousKey === undefined) delete process.env.SESSION_ENCRYPTION_KEY;
      else process.env.SESSION_ENCRYPTION_KEY = previousKey;
    }
  }, 30_000);
});
