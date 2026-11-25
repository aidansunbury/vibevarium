/**
 * Platform event hooks seam (docs/internal/events.md), vendored into generated apps.
 *
 * Off by default. Setting TERRARIUM_EVENTS_SECRET turns it on: the app exposes
 * `POST /hooks/platform`, where the control plane delivers events the app
 * subscribed to. Every delivery is signed by the platform (Standard Webhooks
 * shape): `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<hex>`
 * over `${id}.${timestamp}.${body}` with the app's per-app delivery secret.
 *
 * The app never sees the provider's main webhook secret — the control plane
 * verifies the provider at its own ingress and re-signs for the app. This
 * handler only authenticates the platform, then hands the parsed envelope to
 * the app's own `onEvent` (the app authorizes what it does with the event).
 */
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export interface PlatformEventEnvelope {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly subscriptionId: string;
  readonly payload: unknown;
}

const encoder = new TextEncoder();

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

const hmacSha256 = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
};

/** Constant-time string compare. */
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

/** Verify a platform delivery's signature; returns false for any mismatch. */
export const verifyPlatformSignature = async (
  secret: string,
  headers: { webhookId: string | null; webhookTimestamp: string | null; webhookSignature: string | null },
  rawBody: string,
): Promise<boolean> => {
  const { webhookId, webhookTimestamp, webhookSignature } = headers;
  if (webhookId === null || webhookTimestamp === null || webhookSignature === null) return false;
  const expected = await hmacSha256(secret, `${webhookId}.${webhookTimestamp}.${rawBody}`);
  // The signature header may carry multiple space-separated versioned sigs; match any v1.
  for (const part of webhookSignature.split(" ")) {
    const [version, signature] = part.split(",", 2);
    if (version === "v1" && signature !== undefined && safeEqual(signature, expected)) return true;
  }
  return false;
};

const invalid = (description: string) =>
  HttpServerResponse.json({ error: "invalid_signature", error_description: description }, { status: 401 });

/**
 * The /hooks/platform route. Returns undefined when the events seam is off
 * (no TERRARIUM_EVENTS_SECRET) so the worker falls through to its normal 404;
 * the app's `onEvent` receives the verified envelope.
 */
export const platformHookRoute = (
  secret: string | undefined,
  onEvent: (envelope: PlatformEventEnvelope) => Effect.Effect<void, never, never>,
) =>
  Effect.gen(function*() {
    if (secret === undefined || secret.length === 0) {
      return yield* HttpServerResponse.json({ error: "events_disabled" }, { status: 404 });
    }
    const request = yield* HttpServerRequest;
    const rawBody = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const verified = yield* Effect.promise(() =>
      verifyPlatformSignature(
        secret,
        {
          webhookId: request.headers["webhook-id"] ?? null,
          webhookTimestamp: request.headers["webhook-timestamp"] ?? null,
          webhookSignature: request.headers["webhook-signature"] ?? null,
        },
        rawBody,
      )
    );
    if (!verified) {
      return yield* invalid("The platform event signature did not verify");
    }
    let envelope: PlatformEventEnvelope;
    try {
      envelope = JSON.parse(rawBody) as PlatformEventEnvelope;
    } catch {
      return yield* HttpServerResponse.json({ error: "invalid_envelope" }, { status: 400 });
    }
    yield* onEvent(envelope);
    return yield* HttpServerResponse.json({ received: true, id: envelope.id });
  });

/** Read the events secret from the worker environment; undefined means off. */
export const eventsSecretFromEnv = (env: Record<string, unknown>): string | undefined => {
  const secret = env.TERRARIUM_EVENTS_SECRET;
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
};
