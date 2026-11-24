import { CurrentActor } from "@vibevarium/auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { Acl } from "../acl/index.ts";
import { SecretsProvider, SecretsWriteUnsupportedError } from "./secrets.ts";

type Response = HttpServerResponse.HttpServerResponse;

const json = (body: unknown, status = 200): Effect.Effect<Response, never, never> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text("Internal JSON error", { status: 500 })),
  );

const unsupported = (error: SecretsWriteUnsupportedError) =>
  json({ error: "secrets_read_only", error_description: error.message }, 503);

/** A reference must be a lowercase secret path segment set (no leading slash, no spaces). */
const refPattern = /^[a-z0-9][a-z0-9/_-]*$/;

// The gate factory's exact requirement shape is the caller's business — it
// matches server.ts's `gated` (GUI session OR bearer, providing CurrentActor).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gated = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, any>;

/**
 * Secrets routes (set-only — docs/redeployment-plan.md §3).
 *
 * Trust model: callers can see that a secret EXISTS (name + provenance) and
 * can SET/overwrite/delete one, but can never READ a value back through these
 * routes. On AWS this is enforceable at the credential level (PutSecretValue /
 * CreateSecret / DeleteSecret + ListSecrets, with an explicit Deny on
 * GetSecretValue); the read-capable `resolve` used by the proxy path is a
 * separate concern.
 *
 * Authorization (against the Acl policy, not the provider):
 * - platform secrets (no app) → superadmin only.
 * - app secrets (?app=<name>) → that app's admin members OR superadmin.
 *
 * The caller supplies the `gated` wrapper (server.ts's GUI-session-or-bearer
 * gate) which provides `CurrentActor`. When auth is disabled (local dev) there
 * is no actor and every gate is open — same posture as the rest of the plane.
 */
export const secretsRoutes = (gated: Gated) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const secrets = yield* SecretsProvider;
      const acl = yield* Acl;

      /** Resolve the caller's sub and authorize platform vs app scope. */
      const authorize = (app: string | undefined) =>
        Effect.gen(function*() {
          const actor = yield* Effect.serviceOption(CurrentActor);
          // Dev mode (auth off): no actor — gate open (same posture as the plane).
          if (Option.isNone(actor)) {
            return { allowed: true as const };
          }
          const sub = actor.value.sub;
          if (app === undefined) {
            return (yield* acl.isSuperadmin(sub))
              ? { allowed: true as const }
              : { allowed: false as const, reason: "Platform secrets require superadmin" };
          }
          return (yield* acl.isAdmin(app, sub))
            ? { allowed: true as const }
            : { allowed: false as const, reason: `App secrets for ${app} require an app admin or superadmin` };
        });

      const denied = (reason: string) => json({ error: "forbidden", error_description: reason }, 403);

      const appFromQuery = (url: string) =>
        new URL(url, "http://cp.local").searchParams.get("app") ?? undefined;

      // GET /secrets[?app=<name>] → list names + provenance (never values).
      yield* router.add("GET", "/secrets", gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const app = appFromQuery(request.url);
        const auth = yield* authorize(app);
        if (!auth.allowed) return yield* denied(auth.reason);
        return yield* secrets.list().pipe(
          Effect.map((list) => ({ secrets: list, app: app ?? null })),
          Effect.catch((error: SecretsWriteUnsupportedError) => unsupported(error)),
          Effect.flatMap((value) => json(value)),
        );
      })));

      // PUT /secrets { reference, value, app? } → create or overwrite (set-only).
      yield* router.add("PUT", "/secrets", gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
        const reference = input?.reference;
        const value = input?.value;
        const app = typeof input?.app === "string" ? input.app : undefined;
        if (typeof reference !== "string" || !refPattern.test(reference)) {
          return yield* json({ error: "invalid_body", error_description: "Expected { reference } (lowercase path segments)" }, 400);
        }
        if (typeof value !== "string") {
          return yield* json({ error: "invalid_body", error_description: "Expected { value } (string)" }, 400);
        }
        const auth = yield* authorize(app);
        if (!auth.allowed) return yield* denied(auth.reason);
        return yield* secrets.put(reference, value).pipe(
          Effect.map(() => ({ reference, app: app ?? null, set: true })),
          Effect.catch((error: SecretsWriteUnsupportedError) => unsupported(error)),
          Effect.flatMap((value) => json(value)),
        );
      })));

      // DELETE /secrets { reference, app? } → delete a secret.
      yield* router.add("DELETE", "/secrets", gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
        const reference = input?.reference;
        const app = typeof input?.app === "string" ? input.app : undefined;
        if (typeof reference !== "string" || !refPattern.test(reference)) {
          return yield* json({ error: "invalid_body", error_description: "Expected { reference } (lowercase path segments)" }, 400);
        }
        const auth = yield* authorize(app);
        if (!auth.allowed) return yield* denied(auth.reason);
        return yield* secrets.remove(reference).pipe(
          Effect.map(() => ({ reference, app: app ?? null, deleted: true })),
          Effect.catch((error: SecretsWriteUnsupportedError) => unsupported(error)),
          Effect.flatMap((value) => json(value)),
        );
      })));
    })
  );
