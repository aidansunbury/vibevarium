import { CurrentActor } from "@vibevarium/auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { Acl } from "../acl/index.ts";
import { AppSecrets, AppSecretsError } from "./app-secrets.ts";

const json = (body: unknown, status = 200): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text("Internal JSON error", { status: 500 })),
  );

const appStoreError = (error: AppSecretsError) =>
  json({ error: "app_secrets_error", error_description: error.message }, error.status);

const refPattern = /^[a-z0-9][a-z0-9/_-]*$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gated = <E, R>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, any>;

/**
 * App-scoped, write-only secret management. Platform Secrets Manager entries
 * are deliberately NOT exposed here: they are provisioned outside the control
 * plane and referenced by config/connections.config.ts.
 */
export const secretsRoutes = (gated: Gated) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const acl = yield* Acl;
      const appSecretsOption = yield* Effect.serviceOption(AppSecrets);

      const authorize = (app: string) =>
        Effect.gen(function*() {
          const actor = yield* Effect.serviceOption(CurrentActor);
          if (Option.isNone(actor)) return { allowed: true as const };
          return (yield* acl.isAdmin(app, actor.value.sub))
            ? { allowed: true as const }
            : { allowed: false as const, reason: `App secrets for ${app} require an app admin or superadmin` };
        });

      const denied = (reason: string) => json({ error: "forbidden", error_description: reason }, 403);
      const appRequired = () => json({ error: "app_required", error_description: "An app scope is required" }, 400);
      const unavailable = () => json({ error: "app_secrets_unavailable", error_description: "Cloudflare app-secret store is not configured" }, 503);

      yield* router.add("GET", "/secrets", gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const app = new URL(request.url, "http://cp.local").searchParams.get("app");
        if (app === null || app === "") return yield* appRequired();
        const auth = yield* authorize(app);
        if (!auth.allowed) return yield* denied(auth.reason);
        if (Option.isNone(appSecretsOption)) return yield* unavailable();
        return yield* appSecretsOption.value.list(app).pipe(
          Effect.map((secrets) => ({ secrets, app })),
          Effect.catch((error: AppSecretsError) => appStoreError(error)),
          Effect.flatMap((value) => json(value)),
        );
      })));

      yield* router.add("PUT", "/secrets", gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
        const app = typeof input?.app === "string" ? input.app : undefined;
        if (app === undefined || app === "") return yield* appRequired();
        const reference = input?.reference;
        const value = input?.value;
        if (typeof reference !== "string" || !refPattern.test(reference)) {
          return yield* json({ error: "invalid_body", error_description: "Expected { reference } (lowercase path segments)" }, 400);
        }
        if (typeof value !== "string") {
          return yield* json({ error: "invalid_body", error_description: "Expected { value } (string)" }, 400);
        }
        const auth = yield* authorize(app);
        if (!auth.allowed) return yield* denied(auth.reason);
        if (Option.isNone(appSecretsOption)) return yield* unavailable();
        return yield* appSecretsOption.value.put(app, reference, value).pipe(
          Effect.map(() => ({ reference, app, set: true })),
          Effect.catch((error: AppSecretsError) => appStoreError(error)),
          Effect.flatMap((result) => json(result)),
        );
      })));

      yield* router.add("DELETE", "/secrets", gated(Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
        const app = typeof input?.app === "string" ? input.app : undefined;
        if (app === undefined || app === "") return yield* appRequired();
        const reference = input?.reference;
        if (typeof reference !== "string" || !refPattern.test(reference)) {
          return yield* json({ error: "invalid_body", error_description: "Expected { reference } (lowercase path segments)" }, 400);
        }
        const auth = yield* authorize(app);
        if (!auth.allowed) return yield* denied(auth.reason);
        if (Option.isNone(appSecretsOption)) return yield* unavailable();
        return yield* appSecretsOption.value.remove(app, reference).pipe(
          Effect.map(() => ({ reference, app, deleted: true })),
          Effect.catch((error: AppSecretsError) => appStoreError(error)),
          Effect.flatMap((result) => json(result)),
        );
      })));
    })
  );
