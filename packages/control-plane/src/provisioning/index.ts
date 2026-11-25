/**
 * Job-based async app provisioning (docs/provisioning.md §3).
 *
 * `POST /provisioning` validates the spec against the platform's *capability
 * report* (only options that are enabled AND credential-backed are accepted),
 * inserts a durable `provisioning_jobs` row, and returns `{ jobId }`
 * immediately. The steps — repo → OIDC client → deploy → router → directory →
 * discovery — then run in a background fiber, persisting each step's state as
 * it goes. `GET /provisioning/:jobId` serves the wizard's live stepper and
 * survives restarts (rows are in Postgres/PGlite).
 *
 * Cloudflare is the real deploy path; the AWS target is validated and
 * selectable but its deploy step fails *honestly* ("not yet implemented")
 * rather than silently pretending — that is the concrete next chunk
 * (docs/provisioning.md §6).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Database } from "../store/database.ts";
import { apps, type JobRow, type JobStepRow } from "../store/schema.ts";
import { and, eq as dEq, isNotNull } from "drizzle-orm";
import { PlatformConfigService, validateCapabilities, type CapabilityReport } from "../config/index.ts";
import { Scaffold } from "../scaffold/index.ts";
import { ScaffoldError } from "../scaffold/errors.ts";
import { SecretsProvider } from "../integrations/secrets.ts";
import { JobRunner } from "../jobs/index.ts";
import { provisionStepPlan, type ProvisionPayload } from "../jobs/handlers.ts";
import { CurrentActor, requireAuth } from "@vibevarium/auth";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { isReservedAppName, RESERVED_APP_NAME } from "../reserved.ts";

// The gate factory's exact requirement shape is the caller's business — it
// matches server.ts's `gated` (GUI session OR bearer, providing CurrentActor).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gated = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, any>;

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `control` is the platform's reserved control-surface alias — never an app name. */
const notReserved = Schema.makeFilter((name: string) =>
  isReservedAppName(name)
    ? `"${RESERVED_APP_NAME}" is reserved for the platform control surface and cannot be an app name`
    : undefined
);

export const ProvisionSpec = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(dnsLabel), notReserved),
  target: Schema.optional(Schema.Literals(["cloudflare", "aws"])),
  database: Schema.optional(Schema.Literals(["cf-d1", "planetscale-hyperdrive"])),
  features: Schema.optional(Schema.Array(Schema.Literals(["r2", "hyperdrive"]))),
  /** Preview lineage (docs/previews-and-acl.md): this app is a PR preview of the named parent. */
  previewOf: Schema.optional(Schema.String.check(Schema.isPattern(dnsLabel))),
  previewPr: Schema.optional(Schema.String),
});
export type ProvisionSpec = typeof ProvisionSpec.Type;

export interface ProvisionStart {
  readonly jobId: string;
}

export interface ProvisionStep {
  readonly id: string;
  readonly label: string;
  readonly state: "pending" | "running" | "done" | "failed" | "skipped";
  readonly detail?: string | undefined;
}

export interface ProvisionStatus {
  readonly jobId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "dead";
  readonly steps: ReadonlyArray<ProvisionStep>;
  readonly result?: Record<string, unknown> | undefined;
  readonly error?: string | undefined;
  readonly spec: Record<string, unknown>;
}

/** Map the jobs/job_steps engine rows to the wizard's ProvisionStatus view. */
const toStatus = (job: JobRow, steps: ReadonlyArray<JobStepRow>): ProvisionStatus => ({
  jobId: job.id,
  name: job.name,
  status: job.status,
  steps: steps.map((step) => ({
    id: step.stepId,
    label: step.label,
    state: step.state,
    ...(step.detail === null ? {} : { detail: step.detail }),
  })),
  ...(job.result !== null ? { result: job.result } : {}),
  ...(job.error !== null ? { error: job.error } : {}),
  spec: job.payload,
});

export class Provisioning extends Context.Service<Provisioning, {
  readonly start: (spec: ProvisionSpec, actorSub?: string) => Effect.Effect<ProvisionStart, ScaffoldError>;
  readonly get: (jobId: string) => Effect.Effect<ProvisionStatus, ScaffoldError>;
  readonly options: () => Effect.Effect<CapabilityReport>;
  /** Deploy history: all provision jobs for an app (previews included), newest first. */
  readonly history: (appName: string) => Effect.Effect<ReadonlyArray<ProvisionStatus>>;
  /** Every preview app of a parent (or all previews when parent is undefined). */
  readonly previews: (parentApp?: string) => Effect.Effect<ReadonlyArray<{
    readonly name: string;
    readonly previewOf: string;
    readonly previewPr: string | null;
    readonly url: string;
    readonly status: "unknown" | "up" | "down";
  }>>;
}>()("@vibevarium/control-plane/provisioning/Provisioning") {
  static readonly layer = Layer.effect(Provisioning)(
    Effect.gen(function*() {
      const { db } = yield* Database;
      const config = yield* PlatformConfigService;
      const secrets = yield* SecretsProvider;
      const runner = yield* JobRunner;

      const start = Effect.fnUntraced(function*(rawSpec: ProvisionSpec, actorSub?: string) {
        const target = rawSpec.target ?? config.defaultDeployTarget;
        const database = rawSpec.database ?? config.database;
        const features = rawSpec.features ?? [];
        const spec = { ...rawSpec, target, database, features };

        // Re-validate against the capability report — the wizard only offers
        // backed options, but the route re-checks so a hand-rolled request
        // can't provision an unbacked option.
        const report = yield* validateCapabilities(config, secrets);
        const targetCap = report.deployTargets[target];
        if (!targetCap.enabled) {
          return yield* Effect.fail(new ScaffoldError(400, `Deploy target "${target}" is not enabled`));
        }
        if (!targetCap.credentialsValid) {
          return yield* Effect.fail(new ScaffoldError(
            503,
            `Deploy target "${target}" is missing credentials: ${targetCap.missing.join(", ")}`,
          ));
        }
        // D1 is created by the Cloudflare deploy itself, so it needs no
        // separate credential check (the Cloudflare target check above already
        // covers it). Only external databases (PlanetScale Hyperdrive) carry
        // their own credentials to validate, regardless of target.
        if (database === "planetscale-hyperdrive") {
          const dbCap = report.database[database];
          if (!dbCap.enabled || !dbCap.credentialsValid) {
            return yield* Effect.fail(new ScaffoldError(
              503,
              dbCap.enabled
                ? `Database "${database}" is missing credentials: ${dbCap.missing.join(", ")}`
                : `Database "${database}" is not enabled`,
            ));
          }
        }
        for (const feature of features) {
          const cap = report.features[feature];
          if (!cap.enabled || !cap.credentialsValid) {
            return yield* Effect.fail(new ScaffoldError(
              503,
              cap.enabled
                ? `Feature "${feature}" is missing credentials: ${cap.missing.join(", ")}`
                : `Feature "${feature}" is not enabled`,
            ));
          }
        }

        // Enqueue the durable provision job. The JobRunner runs it with the
        // provision handler (jobs/handlers.ts), checkpointing each step so a
        // redeploy resumes instead of dying. The creator sub travels in the
        // payload (CurrentActor is request-scoped; the runner doesn't inherit it).
        const payload: ProvisionPayload = {
          name: spec.name,
          target,
          database,
          features,
          ...(spec.previewOf === undefined ? {} : { previewOf: spec.previewOf, previewPr: spec.previewPr ?? "" }),
          ...(actorSub === undefined ? {} : { actorSub }),
        };
        const { jobId } = yield* runner.enqueue({
          kind: "provision",
          name: spec.name,
          payload: payload as unknown as Record<string, unknown>,
          steps: provisionStepPlan(spec),
        });
        return { jobId } satisfies ProvisionStart;
      });

      const get = Effect.fnUntraced(function*(jobId: string) {
        const found = yield* runner.get(jobId);
        if (found === undefined || found.job.kind !== "provision") {
          return yield* Effect.fail(new ScaffoldError(404, `Provisioning job ${jobId} not found`));
        }
        return toStatus(found.job, found.steps);
      });

      const options = () => validateCapabilities(config, secrets);

      const history = Effect.fnUntraced(function*(appName: string) {
        const rows = yield* runner.history(appName, "provision");
        return rows.map(({ job, steps }) => toStatus(job, steps));
      });

      const previews = Effect.fnUntraced(function*(parentApp?: string) {
        const where = parentApp === undefined
          ? isNotNull(apps.previewOf)
          : and(isNotNull(apps.previewOf), dEq(apps.previewOf, parentApp));
        const rows = yield* Effect.promise(() => db.select().from(apps).where(where));
        return rows.map((row) => ({
          name: row.name,
          previewOf: row.previewOf ?? "",
          previewPr: row.previewPr,
          url: row.url.replace(/\/mcp$/, ""),
          status: row.status,
        }));
      });

      return Provisioning.of({ start, get, options, history, previews });
    }),
  );

  static readonly routes = (gated: Gated) =>
    HttpRouter.use((router) =>
      Effect.gen(function*() {
        const provisioning = yield* Provisioning;
        const config = yield* PlatformConfigService;

        yield* router.add("GET", "/provisioning/options", gated(Effect.gen(function*() {
          const report = yield* provisioning.options();
          return yield* HttpServerResponse.json({
            defaultTarget: config.defaultDeployTarget,
            defaultDatabase: config.database,
            authProvider: config.authProvider,
            ...report,
          });
        })));

        yield* router.add("POST", "/provisioning", gated(Effect.gen(function*() {
          const request = yield* HttpServerRequest;
          const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
          const decoded = yield* Schema.decodeUnknownEffect(ProvisionSpec)(body).pipe(Effect.result);
          if (Result.isFailure(decoded)) {
            return yield* HttpServerResponse.json(
              { error: "Invalid provision spec", details: decoded.failure.message },
              { status: 400 },
            );
          }
          const actor = yield* Effect.serviceOption(CurrentActor);
          const actorSub = Option.isSome(actor) ? actor.value.sub : undefined;
          const started = yield* provisioning.start(decoded.success, actorSub).pipe(Effect.result);
          return Result.isFailure(started)
            ? yield* HttpServerResponse.json(
                { error: started.failure.message },
                { status: started.failure.status },
              )
            : yield* HttpServerResponse.json(started.success, { status: 202 });
        })));

        yield* router.add("GET", "/provisioning/:jobId", gated(Effect.gen(function*() {
          const params = yield* HttpRouter.params;
          const jobId = params.jobId;
          if (jobId === undefined) {
            return yield* HttpServerResponse.json({ error: "Missing job id" }, { status: 400 });
          }
          const status = yield* provisioning.get(jobId).pipe(Effect.result);
          return Result.isFailure(status)
            ? yield* HttpServerResponse.json(
                { error: status.failure.message },
                { status: status.failure.status },
              )
            : yield* HttpServerResponse.json(status.success);
        })));

        // Preview deploys (docs/previews-and-acl.md): a PR-scoped preview is a
        // provision with preview lineage; Cloudflare-only for now.
        yield* router.add("POST", "/apps/:name/previews", gated(Effect.gen(function*() {
          const params = yield* HttpRouter.params;
          const parent = params.name;
          if (parent === undefined || !dnsLabel.test(parent)) {
            return yield* HttpServerResponse.json({ error: "Invalid app name" }, { status: 400 });
          }
          const request = yield* HttpServerRequest;
          const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed({} as unknown)));
          const rawPr = (body as { pr?: unknown }).pr;
          const pr = typeof rawPr === "string" ? rawPr : typeof rawPr === "number" ? String(rawPr) : undefined;
          if (pr === undefined || pr === "") {
            return yield* HttpServerResponse.json({ error: "Expected { pr } (number or string)" }, { status: 400 });
          }
          const actor = yield* Effect.serviceOption(CurrentActor);
          const actorSub = Option.isSome(actor) ? actor.value.sub : undefined;
          const started = yield* provisioning.start({
            name: `${parent}-pr-${pr}`,
            target: "cloudflare",
            previewOf: parent,
            previewPr: pr,
          }, actorSub).pipe(Effect.result);
          return Result.isFailure(started)
            ? yield* HttpServerResponse.json(
                { error: started.failure.message },
                { status: started.failure.status },
              )
            : yield* HttpServerResponse.json(started.success, { status: 202 });
        })));

        // Previews: every preview app (or one parent's previews via ?app=).
        yield* router.add("GET", "/previews", gated(Effect.gen(function*() {
          const request = yield* HttpServerRequest;
          const url = new URL(request.url, "http://localhost");
          const parent = url.searchParams.get("app") ?? undefined;
          const list = yield* provisioning.previews(parent);
          return yield* HttpServerResponse.json({ previews: list });
        })));

        // Deploy history: every provision job for an app, newest first.
        yield* router.add("GET", "/apps/:name/history", gated(Effect.gen(function*() {
          const params = yield* HttpRouter.params;
          const name = params.name;
          if (name === undefined) {
            return yield* HttpServerResponse.json({ error: "Missing app name" }, { status: 400 });
          }
          const jobs = yield* provisioning.history(name);
          return yield* HttpServerResponse.json({ history: jobs });
        })));
      }),
    );
}
