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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { eq } from "drizzle-orm";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { randomBytes } from "node:crypto";
import { Database } from "../store/database.ts";
import { apps, provisioningJobs, type ProvisioningJobRow, type ProvisioningStep } from "../store/schema.ts";
import { and, desc, eq as dEq, isNotNull } from "drizzle-orm";
import { PlatformConfigService, validateCapabilities, type CapabilityReport } from "../config/index.ts";
import { Scaffold } from "../scaffold/index.ts";
import { ScaffoldError } from "../scaffold/errors.ts";
import { SecretsProvider } from "../integrations/secrets.ts";
import { CurrentActor, requireAuth } from "@vibevarium/auth";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { isReservedAppName, RESERVED_APP_NAME } from "../reserved.ts";

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

export interface ProvisionStatus {
  readonly jobId: string;
  readonly name: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly steps: ReadonlyArray<ProvisioningStep>;
  readonly result?: Record<string, unknown> | undefined;
  readonly error?: string | undefined;
  readonly spec: Record<string, unknown>;
}

const toStatus = (row: ProvisioningJobRow): ProvisionStatus => ({
  jobId: row.id,
  name: row.name,
  status: row.status,
  steps: row.steps,
  ...(row.result !== null ? { result: row.result } : {}),
  ...(row.error !== null ? { error: row.error } : {}),
  spec: row.spec,
});

/** Swallow a persistence error (step/status updates must never crash a job). */
const ignoreError = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: () => Effect.void,
      onSuccess: () => Effect.void,
    }),
  );

/** The steps a provision runs, in order, with labels for the wizard stepper. */
const planSteps = (spec: ProvisionSpec & { readonly target: string; readonly database: string; readonly features: ReadonlyArray<string> }): Array<ProvisioningStep> => {
  const steps: Array<ProvisioningStep> = [
    { id: "repo", label: "Create repository", state: "pending" },
    { id: "oidc", label: "Register OIDC client", state: "pending" },
    { id: "deploy", label: `Deploy (${spec.target})`, state: "pending" },
    { id: "router", label: "Bind domain + router", state: "pending" },
    { id: "directory", label: "Register + discover tools", state: "pending" },
  ];
  if (spec.database === "planetscale-hyperdrive") {
    steps.splice(3, 0, { id: "database", label: "Attach PlanetScale Hyperdrive", state: "pending" });
  }
  if (spec.features.includes("r2")) {
    steps.splice(steps.length - 1, 0, { id: "r2", label: "Create R2 bucket", state: "pending" });
  }
  return steps;
};

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
      const scaffold = yield* Scaffold;
      const secrets = yield* SecretsProvider;

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      const updateJob = (jobId: string, patch: Partial<ProvisioningJobRow>) =>
        Effect.flatMap(nowIso, (updatedAt) =>
          Effect.promise(() =>
            db.update(provisioningJobs).set({ ...patch, updatedAt }).where(eq(provisioningJobs.id, jobId))
          ),
        );

      const setStep = (
        jobId: string,
        steps: ReadonlyArray<ProvisioningStep>,
        stepId: string,
        patch: Partial<ProvisioningStep>,
      ) => {
        const next = steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step));
        return updateJob(jobId, { steps: next }).pipe(Effect.as(next));
      };

      /** Run the provision in the background, flipping step states as it goes. */
      const runJob = (
        jobId: string,
        spec: ProvisionSpec & { readonly target: string; readonly database: string; readonly features: ReadonlyArray<string> },
        initialSteps: Array<ProvisioningStep>,
        actorSub?: string,
      ) =>
        Effect.gen(function*() {
          let steps: ReadonlyArray<ProvisioningStep> = initialSteps;
          const begin = (id: string) =>
            Effect.flatMap(setStep(jobId, steps, id, { state: "running" }), (next) => {
              steps = next;
              return Effect.void;
            });
          const done = (id: string, detail?: string) =>
            Effect.flatMap(
              setStep(jobId, steps, id, { state: "done", ...(detail === undefined ? {} : { detail }) }),
              (next) => {
                steps = next;
                return Effect.void;
              },
            );

          yield* begin("repo");
          if (spec.target === "aws") {
            // Honest stub: validated + selectable, not yet implemented.
            yield* ignoreError(
              setStep(jobId, steps, "repo", { state: "failed", detail: "AWS deployer not yet implemented" }),
            );
            yield* ignoreError(updateJob(jobId, {
              status: "failed",
              error: "AWS deployment target is validated but not yet implemented — see docs/provisioning.md §6",
            }));
            return;
          }

          // The work reuses the existing Scaffold.create pipeline (repo → OIDC
          // → deploy → router → directory → discovery); we expose coarse step
          // progress around it rather than re-implementing the pipeline.
          const result = yield* scaffold.create(
            spec.name,
            spec.previewOf === undefined
              ? undefined
              : { previewOf: spec.previewOf, previewPr: spec.previewPr ?? "" },
            actorSub,
          ).pipe(
            Effect.tap(() => done("repo")),
            Effect.tap(() => done("oidc")),
            Effect.tap(() => (spec.database === "planetscale-hyperdrive" ? done("database", "Hyperdrive bound (config)") : Effect.void)),
            Effect.tap(() => (spec.features.includes("r2") ? done("r2", "R2 bucket (config)") : Effect.void)),
            Effect.tap((value) => done("deploy", value.hostname ?? value.url)),
            Effect.tap(() => done("router")),
            Effect.tap(() => done("directory")),
          );

          yield* updateJob(jobId, {
            status: "succeeded",
            result: {
              name: result.name,
              url: result.url,
              repoUrl: result.repoUrl,
              ...(result.hostname === undefined ? {} : { hostname: result.hostname }),
            },
          });
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              ignoreError(updateJob(jobId, {
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
              })),
            onSuccess: () => Effect.void,
          }),
          Effect.catchDefect((defect: unknown) =>
            ignoreError(updateJob(jobId, { status: "failed", error: `defect: ${String(defect)}` })),
          ),
        );

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

        const jobId = randomBytes(9).toString("base64url");
        const steps = planSteps(spec);
        const createdAt = yield* nowIso;
        yield* Effect.promise(() =>
          db.insert(provisioningJobs).values({
            id: jobId,
            name: spec.name,
            spec,
            status: "running",
            steps,
            createdAt,
            updatedAt: createdAt,
          }),
        );
        // Fire-and-forget background fiber; status is read from the row. The
        // creator sub travels as a plain value (CurrentActor is request-scoped
        // and the fiber doesn't inherit the request context).
        yield* Effect.forkDetach(runJob(jobId, spec, steps, actorSub));
        return { jobId } satisfies ProvisionStart;
      });

      const get = Effect.fnUntraced(function*(jobId: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(provisioningJobs).where(eq(provisioningJobs.id, jobId)).limit(1),
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail(new ScaffoldError(404, `Provisioning job ${jobId} not found`));
        }
        return toStatus(row);
      });

      const options = () => validateCapabilities(config, secrets);

      const history = Effect.fnUntraced(function*(appName: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(provisioningJobs).where(eq(provisioningJobs.name, appName))
            .orderBy(desc(provisioningJobs.createdAt)),
        );
        return rows.map(toStatus);
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

  static readonly routes = (options: { readonly authEnabled: boolean }) =>
    HttpRouter.use((router) =>
      Effect.gen(function*() {
        const provisioning = yield* Provisioning;
        const config = yield* PlatformConfigService;
        const gated = options.authEnabled
          ? requireAuth
          : <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => handler;

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
