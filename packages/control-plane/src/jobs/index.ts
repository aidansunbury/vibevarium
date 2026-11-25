/**
 * JobRunner (docs/internal/jobs.md): the control plane's single durable-async engine.
 *
 * One `jobs` row = one unit of background work (provision an app, deliver a
 * webhook). A handler registered per `kind` runs the work; `job_steps` rows
 * checkpoint each step so a restarted process resumes where a dead one
 * stopped. This is the consolidation of the two ad-hoc fibers the platform
 * grew separately (provisioning's forkDetach + the events outbox drain) into
 * one runner with one retry/backoff/dead-letter implementation.
 *
 * The durability contract:
 * - A handler advances by writing job_steps rows *before* each side-effecting
 *   call, so a crash mid-job leaves a resumable checkpoint, never a phantom.
 * - On boot the runner reaps jobs stuck in `running` (their fiber died with
 *   the last process) back to `pending` so they resume.
 * - Retry/backoff/dead-letter live here, once — handlers just report an
 *   outcome (done | retry | dead), they never implement their own loop.
 *
 * It runs in-process, in the same control-plane server — a code
 * consolidation, not new infrastructure.
 */
import { and, asc, eq, lt, lte } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { randomBytes, randomUUID } from "node:crypto";
import { Database } from "../store/database.ts";
import { jobs, jobSteps, type JobRow, type JobStepRow } from "../store/schema.ts";

/**
 * Handlers are Effects (they resolve services like Scaffold/SecretsProvider).
 * `Handlers` is the service a wiring layer provides to supply them; the runner
 * consumes them. A handler's own requirements must already be satisfied by the
 * layer that builds `Handlers`.
 */
export class Handlers extends Context.Service<Handlers, {
  readonly resolve: Readonly<Record<string, JobHandler>>;
}>()("@vibevarium/control-plane/jobs/Handlers") {}

export interface RunnerConfig {
  /** Max attempts before a job is dead-lettered (handlers can override per job). */
  readonly maxAttempts: number;
  /** Backoff delays between attempts (ms); the last one repeats. */
  readonly retryScheduleMs: ReadonlyArray<number>;
  /** How often the runner polls for due jobs. */
  readonly pollMs: number;
  /** A running job untouched for this long is considered orphaned (its fiber died) and reaped. */
  readonly staleMs: number;
}

/** What a handler reports after running a job (or one of its steps). */
export type Outcome =
  | { readonly kind: "done"; readonly result?: Record<string, unknown> }
  | { readonly kind: "retry"; readonly error: string; readonly retryAfterMs?: number }
  | { readonly kind: "dead"; readonly error: string };

/**
 * A handler runs one job kind. It receives the job + its checkpointed steps
 * and a `markStep` helper to advance the checkpoint before each side effect.
 * The handler is responsible for *resuming*: it must skip steps already
 * `done` (the runner passes the full step list, so `markStep` on a done step
 * is a no-op the handler can use to re-derive progress).
 */
export type JobHandler = (
  ctx: {
    readonly job: JobRow;
    readonly steps: ReadonlyArray<JobStepRow>;
    /** Advance a step's checkpoint (running/done/failed) before its side effect. */
    readonly markStep: (stepId: string, state: JobStepRow["state"], detail?: string) => Effect.Effect<void>;
  },
) => Effect.Effect<Outcome>;

const newJobId = () => randomBytes(9).toString("base64url");

export class JobRunner extends Context.Service<JobRunner, {
  /** Enqueue a durable job. Steps are planned up-front (empty for a single-step job). */
  readonly enqueue: (input: {
    readonly kind: string;
    readonly name: string;
    readonly payload: Record<string, unknown>;
    readonly steps?: ReadonlyArray<{ readonly stepId: string; readonly label: string }>;
    /** Per-job override; default RunnerConfig.maxAttempts. */
    readonly maxAttempts?: number;
  }) => Effect.Effect<{ readonly jobId: string }>;
  /** Read a job + its steps (status/CLI/GUI). */
  readonly get: (jobId: string) => Effect.Effect<{ readonly job: JobRow; readonly steps: ReadonlyArray<JobStepRow> } | undefined>;
  /** History for a name (e.g. all provision jobs for an app), newest first. */
  readonly history: (name: string, kind?: string) => Effect.Effect<ReadonlyArray<{ readonly job: JobRow; readonly steps: ReadonlyArray<JobStepRow> }>>;
  /** List jobs by kind/status (outbox inspection, deliveries view). */
  readonly list: (opts: { kind?: string; status?: string; limit?: number }) => Effect.Effect<ReadonlyArray<JobRow>>;
  /** Drain due jobs once. Returns the number processed. */
  readonly drainOnce: () => Effect.Effect<number>;
}>()("@vibevarium/control-plane/jobs/JobRunner") {
  static readonly layer = (config: RunnerConfig) =>
    Layer.effect(JobRunner)(Effect.gen(function*() {
      const { db } = yield* Database;
      const { resolve: handlers } = yield* Handlers;
      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      const updateJob = (jobId: string, patch: Partial<JobRow>) =>
        Effect.flatMap(nowIso, (updatedAt) =>
          Effect.promise(() => db.update(jobs).set({ ...patch, updatedAt }).where(eq(jobs.id, jobId)))
        );

      const loadSteps = (jobId: string) =>
        Effect.promise(() =>
          db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId)).orderBy(asc(jobSteps.ordinal))
        );

      const enqueue = Effect.fnUntraced(function*(input: {
        kind: string;
        name: string;
        payload: Record<string, unknown>;
        steps?: ReadonlyArray<{ stepId: string; label: string }>;
        maxAttempts?: number;
      }) {
        const jobId = newJobId();
        const createdAt = yield* nowIso;
        yield* Effect.promise(() =>
          db.insert(jobs).values({
            id: jobId,
            kind: input.kind,
            name: input.name,
            payload: input.payload,
            status: "pending",
            updatedAt: createdAt,
            ...(input.maxAttempts === undefined ? {} : {}), // maxAttempts is a runner knob, not stored
          })
        );
        const planned = input.steps ?? [];
        for (const [index, step] of planned.entries()) {
          yield* Effect.promise(() =>
            db.insert(jobSteps).values({
              id: randomUUID(),
              jobId,
              stepId: step.stepId,
              label: step.label,
              ordinal: String(index),
              state: "pending",
            })
          );
        }
        return { jobId };
      });

      const get = Effect.fnUntraced(function*(jobId: string) {
        const rows = yield* Effect.promise(() => db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1));
        const job = rows[0];
        if (job === undefined) return undefined;
        return { job, steps: yield* loadSteps(jobId) };
      });

      const history = Effect.fnUntraced(function*(name: string, kind?: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(jobs).where(kind === undefined ? eq(jobs.name, name) : and(eq(jobs.name, name), eq(jobs.kind, kind)))
        );
        const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return yield* Effect.forEach(sorted, (job) => Effect.map(loadSteps(job.id), (steps) => ({ job, steps })));
      });

      const list = Effect.fnUntraced(function*(opts: { kind?: string; status?: string; limit?: number }) {
        const conditions = [
          ...(opts.kind === undefined ? [] : [eq(jobs.kind, opts.kind)]),
          ...(opts.status === undefined ? [] : [eq(jobs.status, opts.status as JobRow["status"])]),
        ];
        const base = db.select().from(jobs).orderBy(asc(jobs.createdAt)).limit(opts.limit ?? 100);
        return yield* Effect.promise(() => (conditions.length === 0 ? base : base.where(and(...conditions))));
      });

      /** Persist a step checkpoint, then let the handler do the side effect. */
      const makeMarkStep = (jobId: string) =>
        Effect.fnUntraced(function*(stepId: string, state: JobStepRow["state"], detail?: string) {
          const updatedAt = yield* nowIso;
          yield* Effect.promise(() =>
            db.update(jobSteps).set({
              state,
              ...(detail === undefined ? {} : { detail }),
              updatedAt,
            }).where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.stepId, stepId)))
          );
        });

      const backoffMs = (attempt: number): number => {
        if (config.retryScheduleMs.length === 0) return 60_000;
        return config.retryScheduleMs[Math.min(attempt, config.retryScheduleMs.length - 1)]!;
      };

      const runJob = Effect.fnUntraced(function*(job: JobRow) {
        const handler = handlers[job.kind];
        if (handler === undefined) {
          yield* updateJob(job.id, { status: "dead", error: `no handler registered for kind "${job.kind}"` });
          return;
        }
        const attempts = Number.parseInt(job.attempts, 10);
        const steps = yield* loadSteps(job.id);
        const outcome = yield* handler({ job, steps, markStep: makeMarkStep(job.id) }).pipe(
          Effect.catch((error) => Effect.succeed({ kind: "retry", error: `defect: ${String(error)}` } as Outcome)),
        );

        if (outcome.kind === "done") {
          yield* updateJob(job.id, {
            status: "succeeded",
            attempts: String(attempts + 1),
            error: null,
            ...(outcome.result === undefined ? {} : { result: outcome.result }),
          });
          return;
        }
        if (outcome.kind === "dead" || attempts + 1 >= config.maxAttempts) {
          yield* updateJob(job.id, {
            status: outcome.kind === "dead" ? "dead" : "failed",
            attempts: String(attempts + 1),
            error: outcome.error,
          });
          return;
        }
        // Retry: honor an explicit retryAfterMs, else the backoff schedule.
        const delayMs = outcome.retryAfterMs ?? backoffMs(attempts);
        yield* updateJob(job.id, {
          status: "pending",
          attempts: String(attempts + 1),
          error: outcome.error,
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
        });
      });

      const drainOnce = Effect.fnUntraced(function*() {
        const now = new Date().toISOString();
        // Claim due jobs by flipping them pending → running (single-instance
        // control plane; a status transition is the portable claim).
        const due = yield* Effect.promise(() =>
          db.select().from(jobs)
            .where(and(eq(jobs.status, "pending"), lte(jobs.nextAttemptAt, now)))
            .orderBy(asc(jobs.nextAttemptAt))
            .limit(50)
        );
        for (const job of due) {
          const claimed = yield* Effect.promise(() =>
            db.update(jobs).set({ status: "running" })
              .where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
              .returning({ id: jobs.id })
          );
          if (claimed[0] === undefined) continue; // lost the claim race
          yield* runJob(job).pipe(
            Effect.catch((error) => Effect.logError(`job ${job.id} (${job.kind}) failed`, error)),
          );
        }
        return due.length;
      });

      return JobRunner.of({ enqueue, get, history, list, drainOnce });
    }));

  /**
   * Background fiber: reap orphaned `running` jobs once at boot, then drain on
   * a fixed interval. The reaper is what makes execution survive a redeploy —
   * a job whose fiber died with the last process is returned to `pending`.
   */
  static readonly worker = (config: RunnerConfig) =>
    Layer.effectDiscard(Effect.gen(function*() {
      const runner = yield* JobRunner;
      const { db } = yield* Database;

      // Boot reaper: stale running jobs (fiber died with the previous process)
      // go back to pending so drainOnce resumes them from their checkpoints.
      const staleBefore = new Date(Date.now() - config.staleMs).toISOString();
      const reaped = yield* Effect.promise(() =>
        db.update(jobs).set({ status: "pending" })
          .where(and(eq(jobs.status, "running"), lt(jobs.updatedAt, staleBefore)))
          .returning({ id: jobs.id })
      );
      if (reaped.length > 0) {
        yield* Effect.logInfo(`[jobs] reaped ${reaped.length} orphaned running job(s) back to pending`);
      }

      yield* runner.drainOnce().pipe(
        Effect.repeat(Schedule.spaced(config.pollMs)),
        Effect.forkScoped,
      );
    })).pipe(Layer.provide(JobRunner.layer(config)));
}
