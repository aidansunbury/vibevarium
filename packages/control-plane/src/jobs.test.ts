/**
 * JobRunner proof (docs/jobs.md): the unified durable-async engine.
 *
 * - enqueue writes a jobs row + its planned job_steps rows.
 * - drainOnce runs the registered handler and marks the job succeeded.
 * - a retry outcome reschedules; past maxAttempts it dead-letters.
 * - a stale `running` job (its fiber died with the last process) is reset and
 *   resumes — the property that makes a provision survive a redeploy.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { eq } from "drizzle-orm";
import { Database } from "./store/database.ts";
import { jobs } from "./store/schema.ts";
import { Handlers, JobRunner, type JobHandler, type Outcome } from "./jobs/index.ts";

const tempDb = () => mkdtempSync(join(tmpdir(), `vv-jobs-${randomUUID()}-`));

const config = { maxAttempts: 3, retryScheduleMs: [10], pollMs: 10_000, staleMs: 0 };

/** Run `program` against a fresh Database + Handlers + JobRunner stack. */
const run = <A, E>(
  handlers: Readonly<Record<string, JobHandler>>,
  program: Effect.Effect<A, E, JobRunner | Database>,
) => {
  const dbLayer = Database.pgliteLayer(tempDb());
  const handlersLayer = Layer.succeed(Handlers, Handlers.of({ resolve: handlers }));
  const runnerLayer = JobRunner.layer(config).pipe(Layer.provide(handlersLayer), Layer.provide(dbLayer));
  const env = Layer.mergeAll(runnerLayer, dbLayer);
  return Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const context = yield* Layer.build(env);
      const runner = context.pipe(Context.get(JobRunner));
      const database = context.pipe(Context.get(Database));
      return yield* program.pipe(
        Effect.provideService(JobRunner, runner),
        Effect.provideService(Database, database),
      );
    }),
  ));
};

describe("JobRunner", () => {
  it("enqueues a job with its planned steps and drains it to succeeded", async () => {
    const seen: Array<string> = [];
    await run({
      test_kind: ({ markStep }) =>
        Effect.gen(function*() {
          yield* markStep("one", "running");
          seen.push("one");
          yield* markStep("one", "done", "ok");
          return { kind: "done", result: { value: 42 } } satisfies Outcome;
        }),
    }, Effect.gen(function*() {
      const r = yield* JobRunner;
      const { jobId } = yield* r.enqueue({
        kind: "test_kind",
        name: "demo",
        payload: { hello: "world" },
        steps: [{ stepId: "one", label: "First step" }],
      });

      const before = yield* r.get(jobId);
      expect(before?.job.status).toBe("pending");
      expect(before?.steps.map((s) => s.stepId)).toEqual(["one"]);

      yield* r.drainOnce();

      const after = yield* r.get(jobId);
      expect(after?.job.status).toBe("succeeded");
      expect(after?.job.result).toEqual({ value: 42 });
      expect(after?.steps[0]?.state).toBe("done");
      expect(after?.steps[0]?.detail).toBe("ok");
      expect(seen).toEqual(["one"]);
    }));
  });

  it("retries a retry outcome, then fails past maxAttempts", async () => {
    let calls = 0;
    await run({
      flaky: () => {
        calls += 1;
        return Effect.succeed({ kind: "retry", error: "boom" } satisfies Outcome);
      },
    }, Effect.gen(function*() {
      const r = yield* JobRunner;
      const { db } = yield* Database;
      const { jobId } = yield* r.enqueue({ kind: "flaky", name: "x", payload: {} });
      for (let i = 0; i < 3; i++) {
        yield* Effect.promise(() => db.update(jobs).set({ nextAttemptAt: new Date(0).toISOString() }).where(eq(jobs.id, jobId)));
        yield* r.drainOnce();
      }
      const after = yield* r.get(jobId);
      expect(calls).toBe(3);
      expect(after?.job.status).toBe("failed");
      expect(after?.job.error).toBe("boom");
    }));
  });

  it("resumes a stale running job (fiber died with the last process)", async () => {
    await run({
      noop: () => Effect.succeed({ kind: "done" } satisfies Outcome),
    }, Effect.gen(function*() {
      const r = yield* JobRunner;
      const { db } = yield* Database;
      const { jobId } = yield* r.enqueue({ kind: "noop", name: "orphan", payload: {} });
      // Simulate a job orphaned mid-run, then the boot reaper resetting it to pending.
      yield* Effect.promise(() =>
        db.update(jobs).set({ status: "pending", nextAttemptAt: new Date(0).toISOString() }).where(eq(jobs.id, jobId))
      );
      yield* r.drainOnce();
      const after = yield* r.get(jobId);
      expect(after?.job.status).toBe("succeeded");
    }));
  });
});
