import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SecretMeta } from "./secrets.ts";

/**
 * Per-app secrets for Cloudflare-deployed apps (docs/redeployment-plan.md §3).
 *
 * An app secret is a **Worker secret** bound to the app's own Worker — the
 * secret lives in the app's cloud, not the control plane. The control plane
 * writes/lists/deletes them via the Cloudflare API with the platform's
 * Cloudflare token:
 *   - list → GET /workers/scripts/:worker/secrets       (names only, never values)
 *   - put  → PUT /workers/scripts/:worker/secrets        ({ name, text, type })
 *   - remove → DELETE /workers/scripts/:worker/secrets/:name
 *
 * Set-only trust model: the Cloudflare *token* technically could read a value
 * (Workers Scripts Edit scope covers GET /secrets/:name), but this interface
 * only ever calls list (names) / put / delete — never the value GET. So
 * "never read back" is enforced in code, same as the Cloudflare console.
 *
 * The worker name equals the app name (the scaffold deploys each app as a
 * Worker named after it).
 */
export interface AppSecretsOptions {
  readonly accountId: string;
  readonly apiToken: string;
}

export class AppSecretsError extends Error {
  readonly _tag = "AppSecretsError";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const cfBase = "https://api.cloudflare.com/client/v4";

export class AppSecrets extends Context.Service<AppSecrets, {
  readonly list: (worker: string) => Effect.Effect<ReadonlyArray<SecretMeta>, AppSecretsError>;
  readonly put: (worker: string, name: string, value: string) => Effect.Effect<void, AppSecretsError>;
  readonly remove: (worker: string, name: string) => Effect.Effect<void, AppSecretsError>;
}>()("@vibevarium/control-plane/integrations/AppSecrets") {
  static readonly layer = (options: AppSecretsOptions) =>
    Layer.succeed(AppSecrets, AppSecrets.of({
      list: (worker) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(
              `${cfBase}/accounts/${options.accountId}/workers/scripts/${worker}/secrets`,
              { headers: { authorization: `Bearer ${options.apiToken}` } },
            );
            const body = (await response.json()) as {
              result?: Array<{ name?: string; type?: string }>;
              success?: boolean;
              errors?: Array<{ message?: string }>;
            };
            if (!response.ok) {
              throw new AppSecretsError(response.status, body.errors?.[0]?.message ?? `Cloudflare list failed (${response.status})`);
            }
            return (body.result ?? []).map((entry) => ({ name: entry.name ?? "" })).filter((entry) => entry.name !== "");
          },
          catch: (cause) =>
            cause instanceof AppSecretsError ? cause : new AppSecretsError(502, cause instanceof Error ? cause.message : String(cause)),
        }),
      put: (worker, name, value) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(
              `${cfBase}/accounts/${options.accountId}/workers/scripts/${worker}/secrets`,
              {
                method: "PUT",
                headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" },
                body: JSON.stringify({ name, text: value, type: "secret_text" }),
              },
            );
            if (!response.ok) {
              const body = (await response.json().catch(() => ({}))) as { errors?: Array<{ message?: string }> };
              throw new AppSecretsError(response.status, body.errors?.[0]?.message ?? `Cloudflare put failed (${response.status})`);
            }
          },
          catch: (cause) =>
            cause instanceof AppSecretsError ? cause : new AppSecretsError(502, cause instanceof Error ? cause.message : String(cause)),
        }),
      remove: (worker, name) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(
              `${cfBase}/accounts/${options.accountId}/workers/scripts/${worker}/secrets/${encodeURIComponent(name)}`,
              { method: "DELETE", headers: { authorization: `Bearer ${options.apiToken}` } },
            );
            if (!response.ok) {
              const body = (await response.json().catch(() => ({}))) as { errors?: Array<{ message?: string }> };
              throw new AppSecretsError(response.status, body.errors?.[0]?.message ?? `Cloudflare delete failed (${response.status})`);
            }
          },
          catch: (cause) =>
            cause instanceof AppSecretsError ? cause : new AppSecretsError(502, cause instanceof Error ? cause.message : String(cause)),
        }),
    }));
}
