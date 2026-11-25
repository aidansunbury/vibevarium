/**
 * Events HTTP routes (docs/internal/events.md).
 *
 * Two surfaces:
 * - INGRESS: `POST /events/:source` — public, verified by the source's own
 *   secret (HMAC signature / bearer / none), NOT by a platform session. This
 *   is the path-exemptions `authMode: "app"` shape: the control plane
 *   authenticates the provider, then fans out. 503 events_not_configured when
 *   the feature is off so providers retry/alert instead of a false 200.
 * - Static source reads + subscription CRUD (app owner/admin or superadmin)
 *   under the standard GUI-session-or-bearer gate. Sources cannot be registered
 *   or mutated through HTTP.
 */
import { CurrentActor } from "@vibevarium/auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Acl } from "../acl/index.ts";
import { SecretsProvider } from "../integrations/secrets.ts";
import { CreateSubscriptionInput, EventError, Events, type NormalizedEvent } from "./service.ts";
import { ConnectionsConfigService } from "../config/connections-schema.ts";

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const respond = <A>(effect: Effect.Effect<A, EventError>, successStatus = 200) =>
  effect.pipe(
    Effect.tapDefect((cause) => Effect.logError("events route defect", cause)),
    Effect.matchEffect({
      onFailure: (error: EventError) =>
        HttpServerResponse.json({ error: error.code, error_description: error.message }, { status: error.status }),
      onSuccess: (value) => HttpServerResponse.json(value, { status: successStatus }),
    }),
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gated = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, any>;

/** Constant-time string compare. */
const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
};

/** Verify the inbound provider request against the source's secret. */
const verifyIngress = (
  verification: string,
  secret: string,
  headers: Record<string, string>,
  rawBody: string,
): boolean => {
  if (verification === "none") return true;
  if (verification === "bearer") {
    const auth = headers["authorization"] ?? "";
    return safeEqual(auth, `Bearer ${secret}`) || safeEqual(auth, secret);
  }
  // hmac-sha256: try the common provider signature header shapes.
  const candidates = [
    headers["x-hub-signature-256"], // GitHub: sha256=<hex>
    headers["stripe-signature"], // Stripe: t=...,v1=<hex>
    headers["x-signature"],
    headers["x-vibevarium-signature"],
  ].filter((value): value is string => value !== undefined && value !== "");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  for (const candidate of candidates) {
    if (candidate.startsWith("sha256=") && safeEqual(candidate.slice("sha256=".length), expected)) return true;
    // Stripe v1=<hex> within a comma-separated header.
    const v1 = /(?:^|,)v1=([a-f0-9]+)/.exec(candidate)?.[1];
    if (v1 !== undefined && safeEqual(v1, expected)) return true;
    if (safeEqual(candidate, expected)) return true;
  }
  return false;
};

/** Best-effort event-type + id extraction for common providers. */
const normalize = (
  sourceName: string,
  eventTypeHeader: string | null,
  headers: Record<string, string>,
  payload: unknown,
): NormalizedEvent => {
  const body = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const headerType = eventTypeHeader !== null ? headers[eventTypeHeader.toLowerCase()] : undefined;
  const bodyType = typeof body["type"] === "string" ? (body["type"] as string) : undefined;
  const bodyAction = typeof body["action"] === "string" ? (body["action"] as string) : undefined;
  const eventType = headerType ?? bodyType ?? bodyAction ?? "unknown";
  const headerId = headers["x-github-delivery"] ?? headers["x-request-id"];
  const bodyId = typeof body["id"] === "string" ? (body["id"] as string) : undefined;
  const eventId = headerId ?? bodyId ?? null;
  // Structured scope hints: the repo (github) / account (stripe) for Layer-1 narrowing.
  const scopes: Array<string> = [];
  const repo = body["repository"];
  if (typeof repo === "object" && repo !== null && typeof (repo as Record<string, unknown>)["full_name"] === "string") {
    scopes.push((repo as Record<string, unknown>)["full_name"] as string);
  }
  const account = body["account"];
  if (typeof account === "string") scopes.push(account);
  return { source: sourceName, eventId, eventType, scopes, payload };
};

const parsePayload = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
};

export const eventsRoutes = (gated: Gated) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const events = yield* Events;
      const acl = yield* Acl;
      const secrets = yield* SecretsProvider;
      const connectionsConfig = yield* ConnectionsConfigService;

      // ----- INGRESS (secret-verified, not platform-auth) --------------------
      const ingress = Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const sourceName = params.source;
        if (sourceName === undefined || !namePattern.test(sourceName)) {
          return yield* HttpServerResponse.json({ error: "invalid_source" }, { status: 400 });
        }
        const request = yield* HttpServerRequest;
        const rawBody = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));

        const source = Option.getOrUndefined(yield* events.getSource(sourceName));
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) headers[key.toLowerCase()] = value;

        // Always verify (when a source exists + uses a secret), even when the
        // feature is off — never leak whether events_not_configured would fire
        // to an unauthenticated caller probing with bad signatures.
        if (source !== undefined && source.verification !== "none") {
          const ref = connectionsConfig.secretRef(source.secret);
          const secret = ref === undefined ? Option.none<string>() : yield* secrets.resolve(ref);
          if (Option.isNone(secret) || !verifyIngress(source.verification, secret.value, headers, rawBody)) {
            return yield* HttpServerResponse.json({ error: "invalid_signature" }, { status: 401 });
          }
        }
        const payload = parsePayload(rawBody);
        const event = source !== undefined
          ? normalize(sourceName, source.eventTypeHeader, headers, payload)
          : { source: sourceName, eventId: null, eventType: "unknown", scopes: [] as Array<string>, payload };
        return yield* respond(events.publish(sourceName, event));
      });
      yield* router.add("POST", "/events/:source", ingress);

      // Sources are static config; only subscriptions are runtime-managed.
      const listSources = gated(Effect.gen(function*() {
        const sources = yield* events.listSources();
        return yield* HttpServerResponse.json({ sources });
      }));
      yield* router.add("GET", "/events/sources", listSources);

      // ----- SUBSCRIPTION CRUD (app owner/admin or superadmin) ---------------
      const createSubscription = gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const decoded = yield* Schema.decodeUnknownEffect(CreateSubscriptionInput)(body).pipe(Effect.result);
        if (Result.isFailure(decoded)) {
          return yield* HttpServerResponse.json(
            { error: "invalid_input", details: decoded.failure.message },
            { status: 400 },
          );
        }
        const actor = yield* Effect.serviceOption(CurrentActor);
        let input = decoded.success;
        if (Option.isSome(actor)) {
          const sub = actor.value.sub;
          const allowed = (yield* acl.isAdmin(input.app, sub)) || (yield* acl.canAccess(input.app, sub));
          if (!allowed) {
            return yield* HttpServerResponse.json(
              { error: `You do not have access to ${input.app}` },
              { status: 403 },
            );
          }
          input = { ...input, createdBy: sub };
        }
        return yield* respond(events.subscribe(input), 201);
      }));
      yield* router.add("POST", "/events/subscriptions", createSubscription);

      const listSubscriptions = gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://events.local");
        const app = url.searchParams.get("app") ?? undefined;
        const source = url.searchParams.get("source") ?? undefined;
        const actor = yield* Effect.serviceOption(CurrentActor);
        if (Option.isSome(actor) && app !== undefined) {
          const allowed = yield* acl.canAccess(app, actor.value.sub);
          if (!allowed) {
            return yield* HttpServerResponse.json({ error: `You do not have access to ${app}` }, { status: 403 });
          }
        }
        const subscriptions = yield* events.listSubscriptions({
          ...(app === undefined ? {} : { app }),
          ...(source === undefined ? {} : { source }),
        });
        return yield* HttpServerResponse.json({ subscriptions });
      }));
      yield* router.add("GET", "/events/subscriptions", listSubscriptions);

      const deleteSubscription = gated(Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const id = params.id;
        if (id === undefined) {
          return yield* HttpServerResponse.json({ error: "missing_id" }, { status: 400 });
        }
        const subs = yield* events.listSubscriptions({});
        const target = subs.find((sub) => sub.id === id);
        if (target === undefined) {
          return yield* HttpServerResponse.json({ error: "not_found" }, { status: 404 });
        }
        const actor = yield* Effect.serviceOption(CurrentActor);
        if (Option.isSome(actor)) {
          const allowed = (yield* acl.isAdmin(target.app, actor.value.sub)) ||
            (yield* acl.isSuperadmin(actor.value.sub));
          if (!allowed) {
            return yield* HttpServerResponse.json(
              { error: `Only admins of ${target.app} can remove subscriptions` },
              { status: 403 },
            );
          }
        }
        return yield* respond(Effect.as(events.unsubscribe(id), { removed: id }));
      }));
      yield* router.add("DELETE", "/events/subscriptions/:id", deleteSubscription);

      const listDeliveries = gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://events.local");
        const subscriptionId = url.searchParams.get("subscriptionId") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        const deliveries = yield* events.listDeliveries({
          ...(subscriptionId === undefined ? {} : { subscriptionId }),
          ...(status === undefined ? {} : { status }),
        });
        // Deliveries are jobs rows (kind = deliver_webhook); the webhook-specific
        // fields live in the job payload. Map to the flat delivery view.
        return yield* HttpServerResponse.json({
          deliveries: deliveries.map((row) => {
            const payload = row.payload as { subscriptionId?: string; eventId?: string | null; source?: string; eventType?: string };
            return {
              id: row.id,
              subscriptionId: payload.subscriptionId ?? "",
              eventId: payload.eventId ?? null,
              source: payload.source ?? "",
              eventType: payload.eventType ?? "",
              status: row.status,
              attempts: row.attempts,
              lastError: row.error,
              lastStatus: row.result === null || row.result === undefined ? null : String((row.result as { status?: unknown }).status ?? ""),
              createdAt: row.createdAt,
            };
          }),
        });
      }));
      yield* router.add("GET", "/events/deliveries", listDeliveries);
    }),
  );
