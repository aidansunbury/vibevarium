import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startControlPlane } from "./server.ts";

/** A unique PGlite data dir per control plane (PGlite has no true in-memory mode). */
const tempDb = () => mkdtempSync(join(tmpdir(), `vv-events-${randomUUID()}-`));

/**
 * End-to-end events proof (docs/events.md), auth disabled (local-dev mode):
 * register a source + a receiver app + a subscription, POST a signed event to
 * the ingress, and assert the fan-out delivery arrives at the app's
 * /hooks/platform endpoint with a valid platform signature.
 */
const SECRET = "test-source-secret";
const APP_SECRET = "ci-bot-delivery-secret";

const signGitHub = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

/** Mirror of the template's platform-hook verification (hooks.ts): v1,<hex> over id.timestamp.body. */
const verifyPlatform = (secret: string, headers: ReceivedHook["headers"], body: string): boolean => {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"];
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string") return false;
  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`, "utf8").digest("hex");
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    return version === "v1" && sig === expected;
  });
};

interface ReceivedHook {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

describe("events", () => {
  let controlPlane: { url: string };
  let receiver: Server;
  let receiverUrl: string;
  let received: Array<ReceivedHook>;
  let scope: Scope.Closeable;

  beforeAll(async () => {
    // A fake subscriber app: records POSTs to /hooks/platform.
    received = [];
    receiver = createServer((req, res) => {
      if (req.url === "/hooks/platform" && req.method === "POST") {
        const chunks: Array<Buffer> = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    process.env["GITHUB_WEBHOOK_SECRET"] = SECRET;
    // The receiver app's platform delivery secret (convention ref APP_EVENTS_SECRET_CI_BOT).
    process.env["APP_EVENTS_SECRET_CI_BOT"] = APP_SECRET;

    scope = await Effect.runPromise(Scope.make());
    controlPlane = await Effect.runPromise(
      Effect.provideService(startControlPlane({
        port: 0,
        host: "127.0.0.1",
        databasePath: tempDb(),
        discoveryIntervalMs: 0,
        events: { maxAttempts: 3, retryScheduleMs: [50, 100], pollMs: 50 },
      }), Scope.Scope, scope),
    );
  }, 30_000);

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    receiver.close();
    delete process.env["GITHUB_WEBHOOK_SECRET"];
    delete process.env["APP_EVENTS_SECRET_CI_BOT"];
  });

  it("fans a signed ingress event out to the subscribed app with a platform signature", async () => {
    // Register the receiver app.
    const appRes = await fetch(`${controlPlane.url}/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci-bot", url: receiverUrl }),
    });
    expect(appRes.status).toBe(201);

    // Register the github source (secretRef → env var GITHUB_WEBHOOK_SECRET).
    const srcRes = await fetch(`${controlPlane.url}/events/sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "github",
        displayName: "GitHub",
        secretRef: "GITHUB_WEBHOOK_SECRET",
        verification: "hmac-sha256",
        eventTypeHeader: "x-github-event",
      }),
    });
    expect(srcRes.status).toBe(201);
    const source = await srcRes.json();
    expect(source.secretConfigured).toBe(true);

    // Subscribe the app to push events on one repo.
    const subRes = await fetch(`${controlPlane.url}/events/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app: "ci-bot",
        source: "github",
        eventTypes: ["push"],
        scopes: ["org/app-one"],
      }),
    });
    expect(subRes.status).toBe(201);
    const subscription = await subRes.json();

    // A matching signed event fans out.
    const body = JSON.stringify({ action: "push", repository: { full_name: "org/app-one" }, ref: "refs/heads/main" });
    const ingressRes = await fetch(`${controlPlane.url}/events/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "evt-1",
        "x-hub-signature-256": signGitHub(SECRET, body),
      },
      body,
    });
    expect(ingressRes.status).toBe(200);
    const ingress = await ingressRes.json();
    expect(ingress.matched).toBe(1);

    // The delivery fiber drains and the app receives a signed envelope.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(received.length).toBe(1);
    const hook = received[0]!;
    const envelope = JSON.parse(hook.body);
    expect(envelope.source).toBe("github");
    expect(envelope.type).toBe("push");
    expect(envelope.subscriptionId).toBe(subscription.id);
    expect(envelope.payload.ref).toBe("refs/heads/main");
    // Platform→app signature headers are present and verify against the app's
    // delivery secret (the exact algorithm the template's hooks.ts checks).
    expect(hook.headers["webhook-id"]).toBeTruthy();
    expect(hook.headers["webhook-signature"]).toMatch(/^v1,/);
    expect(verifyPlatform(APP_SECRET, hook.headers, hook.body)).toBe(true);
    // And it correctly rejects a wrong secret.
    expect(verifyPlatform("wrong-secret", hook.headers, hook.body)).toBe(false);

    // A non-matching event (different repo) fans out to nobody.
    const otherBody = JSON.stringify({ action: "push", repository: { full_name: "org/other" } });
    const missRes = await fetch(`${controlPlane.url}/events/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": signGitHub(SECRET, otherBody),
      },
      body: otherBody,
    });
    expect((await missRes.json()).matched).toBe(0);

    // A bad signature is rejected before any fan-out.
    const badRes = await fetch(`${controlPlane.url}/events/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body,
    });
    expect(badRes.status).toBe(401);
  }, 30_000);

  it("reports events_not_configured when the feature is off", async () => {
    const scope2 = await Effect.runPromise(Scope.make());
    try {
      const off = await Effect.runPromise(
        Effect.provideService(startControlPlane({
          port: 0,
          host: "127.0.0.1",
          databasePath: tempDb(),
          discoveryIntervalMs: 0,
        }), Scope.Scope, scope2),
      );
      const res = await fetch(`${off.url}/events/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("events_not_configured");
    } finally {
      await Effect.runPromise(Scope.close(scope2, Exit.void));
    }
  }, 30_000);
});
