/**
 * The JobRunner's built-in handlers (docs/internal/jobs.md).
 *
 * - `provision` — the multi-step app-creation saga. Steps are planned at
 *   enqueue time (repo → oidc → deploy → router → directory, plus optional
 *   database/r2). It reuses the Scaffold.create pipeline and checkpoints each
 *   coarse step so a redeploy resumes at the first non-done step. Because
 *   Scaffold.create runs as one pipeline, resume re-enters it and it re-runs
 *   idempotently up to the failed step — the checkpoint is what the wizard's
 *   stepper + the reaper read, not a partial-execution boundary.
 * - `deliver_webhook` — a single-step job: POST the envelope (in payload) to
 *   the app's /hooks/platform, signed with the app's delivery secret, with the
 *   PR-8 failure classification (transient → backoff, terminal 4xx → dead,
 *   429 → honor Retry-After).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createHmac } from "node:crypto";
import { apps, eventSubscriptions } from "../store/schema.ts";
import { eq } from "drizzle-orm";
import { Database } from "../store/database.ts";
import { SecretsProvider } from "../integrations/secrets.ts";
import { Scaffold } from "../scaffold/index.ts";
import { asScaffoldError } from "../scaffold/errors.ts";
import type { JobHandler, Outcome } from "./index.ts";

// ---------------------------------------------------------------------------
// Shared payload shapes (the `jobs.payload` contract per kind)
// ---------------------------------------------------------------------------

export interface ProvisionPayload {
  readonly name: string;
  readonly target: string;
  readonly database: string;
  readonly features: ReadonlyArray<string>;
  readonly previewOf?: string;
  readonly previewPr?: string;
  readonly actorSub?: string;
}

export interface DeliverWebhookPayload {
  readonly subscriptionId: string;
  /** The wrapped envelope delivered to the app (platform metadata + raw payload). */
  readonly envelope: Record<string, unknown>;
  /** Provider's event id (dedupe key) when available. */
  readonly eventId: string | null;
  readonly source: string;
  readonly eventType: string;
}

// ---------------------------------------------------------------------------
// provision
// ---------------------------------------------------------------------------

/** The coarse step plan a provision checkpoints (mirrors the old wizard stepper). */
export const provisionStepPlan = (spec: {
  readonly target: string;
  readonly database: string;
  readonly features: ReadonlyArray<string>;
}): ReadonlyArray<{ readonly stepId: string; readonly label: string }> => {
  const steps: Array<{ stepId: string; label: string }> = [
    { stepId: "repo", label: "Create repository" },
    { stepId: "oidc", label: "Register OIDC client" },
    { stepId: "deploy", label: `Deploy (${spec.target})` },
    { stepId: "router", label: "Bind domain + router" },
    { stepId: "directory", label: "Register + discover tools" },
  ];
  if (spec.database === "planetscale-hyperdrive") {
    steps.splice(3, 0, { stepId: "database", label: "Attach PlanetScale Hyperdrive" });
  }
  if (spec.features.includes("r2")) {
    steps.splice(steps.length - 1, 0, { stepId: "r2", label: "Create R2 bucket" });
  }
  return steps;
};

export const provisionHandler = Effect.gen(function*() {
  const scaffold = yield* Scaffold;

  const handler: JobHandler = ({ job, markStep }) =>
    Effect.gen(function*() {
      const spec = job.payload as unknown as ProvisionPayload;

      // Honest stub: the AWS target is validated + selectable but not implemented.
      if (spec.target === "aws") {
        yield* markStep("repo", "failed", "AWS deployer not yet implemented");
        return {
          kind: "dead",
          error: "AWS deployment target is validated but not yet implemented — see docs/internal/provisioning.md §6",
        } satisfies Outcome;
      }

      yield* markStep("repo", "running");

      // The work reuses the Scaffold.create pipeline (repo → OIDC → deploy →
      // router → directory → discovery); we checkpoint coarse step progress
      // around it. On resume after a redeploy the pipeline re-runs
      // idempotently, so a completed run is never double-provisioned.
      const result = yield* scaffold.create(
        spec.name,
        spec.previewOf === undefined ? undefined : { previewOf: spec.previewOf, previewPr: spec.previewPr ?? "" },
        spec.actorSub,
      ).pipe(
        Effect.tap(() => markStep("repo", "done")),
        Effect.tap(() => markStep("oidc", "done")),
        Effect.tap(() =>
          spec.database === "planetscale-hyperdrive" ? markStep("database", "done", "Hyperdrive bound (config)") : Effect.void
        ),
        Effect.tap(() => (spec.features.includes("r2") ? markStep("r2", "done", "R2 bucket (config)") : Effect.void)),
        Effect.tap((value) => markStep("deploy", "done", value.hostname ?? value.url)),
        Effect.tap(() => markStep("router", "done")),
        Effect.tap(() => markStep("directory", "done")),
        Effect.map((value) =>
          ({
            kind: "done",
            result: {
              name: value.name,
              url: value.url,
              repoUrl: value.repoUrl,
              ...(value.hostname === undefined ? {} : { hostname: value.hostname }),
            },
          }) satisfies Outcome
        ),
        Effect.catch((error) => {
          const e = asScaffoldError(error);
          return Effect.succeed({ kind: "dead", error: e.message } satisfies Outcome);
        }),
      );
      return result;
    });

  return handler;
});

// ---------------------------------------------------------------------------
// deliver_webhook
// ---------------------------------------------------------------------------

const sign = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

/** Standard-Webhooks-style signature headers for a delivery. */
const signatureHeaders = (secret: string, deliveryId: string, timestampSec: number, body: string) => {
  const signedContent = `${deliveryId}.${timestampSec}.${body}`;
  return {
    "webhook-id": deliveryId,
    "webhook-timestamp": String(timestampSec),
    "webhook-signature": `v1,${sign(secret, signedContent)}`,
  };
};

const classify = (status: number, retryAfterMs: number | null): Outcome => {
  if (status >= 200 && status < 300) return { kind: "done", result: { status } };
  if (status === 429) return { kind: "retry", error: "rate_limited", ...(retryAfterMs === null ? {} : { retryAfterMs }) };
  if (status === 408) return { kind: "retry", error: "request_timeout" };
  if (status >= 500) return { kind: "retry", error: `upstream_${status}` };
  // Other 4xx are terminal: the endpoint won't heal by retrying.
  return { kind: "dead", error: `terminal_${status}` };
};

export const deliverWebhookHandler = Effect.gen(function*() {
  const { db } = yield* Database;
  const secrets = yield* SecretsProvider;

  const handler: JobHandler = ({ job }) =>
    Effect.gen(function*() {
      const payload = job.payload as unknown as DeliverWebhookPayload;

      // Resolve the subscription + app URL + signing secret.
      const subRows = yield* Effect.promise(() =>
        db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, payload.subscriptionId)).limit(1)
      );
      const sub = subRows[0];
      const appRows = yield* Effect.promise(() =>
        db.select().from(apps).where(eq(apps.name, sub?.app ?? "")).limit(1)
      );
      const app = appRows[0];

      if (sub === undefined || app === undefined) {
        return { kind: "dead", error: "subscription_or_app_missing" } satisfies Outcome;
      }
      const secret = sub.deliverySecretRef === null ? Option.none<string>() : yield* secrets.resolve(sub.deliverySecretRef);
      if (Option.isNone(secret)) {
        return { kind: "dead", error: "delivery_secret_unavailable" } satisfies Outcome;
      }

      const body = JSON.stringify(payload.envelope);
      const timestampSec = Math.floor(Date.now() / 1000);
      const target = `${app.url.replace(/\/+$/, "")}/hooks/platform`;

      const response = yield* Effect.tryPromise({
        try: async () => {
          const res = await fetch(target, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...signatureHeaders(secret.value, job.id, timestampSec, body),
            },
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          });
          const retryAfter = res.headers.get("retry-after");
          const retryAfterMs = retryAfter === null
            ? null
            : /^\d+$/.test(retryAfter)
              ? Number.parseInt(retryAfter, 10) * 1_000
              : null;
          return { status: res.status, retryAfterMs };
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => Effect.succeed({ status: -1, retryAfterMs: null, transportError: String(error) })),
      );

      if ("transportError" in response) {
        return { kind: "retry", error: `transport: ${response.transportError}` } satisfies Outcome;
      }
      return classify(response.status, response.retryAfterMs);
    });

  return handler;
});
