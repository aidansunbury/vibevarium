# Jobs (the durable-async engine)

The control plane's single mechanism for "accept a request, then do slow or
flaky external work in the background." Provisioning an app and delivering a
webhook are the two current kinds; both run on one engine instead of each
growing its own fiber + retry loop.

## Why one engine

The platform grew the same pattern twice, slightly differently:

- **Provisioning** persisted its steps (a jsonb array) so the wizard could
  poll — but ran in a fire-and-forget `forkDetach` fiber, so a control-plane
  redeploy killed the work mid-flight and left the row stuck at `running`.
- **The events outbox** retried and dead-lettered correctly — but was a
  single-step loop hardwired to "POST a webhook," with its own table and its
  own backoff implementation.

Both are the same idea: **commit the intent to Postgres, then let a drainer
make the side effect happen at-least-once.** The JobRunner consolidates them:
one table, one drainer, one retry/backoff/dead-letter implementation, and —
the part neither had — a **boot reaper** that resumes jobs orphaned by a
redeploy. It is a *code* consolidation: same process, same database, no new
infrastructure.

## The two tables

**`jobs`** — one row per unit of work.

| column | purpose |
| --- | --- |
| `id` | base64url id |
| `kind` | discriminator the runner routes on (`provision`, `deliver_webhook`, …) |
| `name` | human label (the app name) for history/CLI display |
| `payload` | **arbitrary jsonb input** — the provision spec, or the webhook envelope + target + signing ref |
| `status` | `pending` · `running` · `succeeded` · `failed` · `dead` |
| `attempts` | how many times the handler has run |
| `next_attempt_at` | when the job next becomes due — the scheduling + backoff column |
| `result` | set at completion (provision result, delivery response) |
| `error` | last failure detail |

**`job_steps`** — one row per step in a multi-step job.

| column | purpose |
| --- | --- |
| `job_id` | FK → jobs (cascade) |
| `step_id` / `label` | stable id + display label ("repo", "Register OIDC client") |
| `ordinal` | order within the job — the runner resumes at the first non-`done` step |
| `state` | `pending` · `running` · `done` · `failed` · `skipped` |
| `detail` | what the step produced / its failure (deploy URL, webhook status) |

A **single-step job** (a webhook delivery) has one `job_steps` row
(`step_id = "post"`); a **multi-step job** (a provision) has one per saga
step. The wizard's stepper and the delivery audit both read these.

## The runner

`JobRunner` (packages/control-plane/src/jobs/index.ts) holds a handler
registry (`kind → handler`). Its worker:

1. **Boot reaper.** Any job stuck in `running` (its fiber died with the
   previous process) is returned to `pending`. This is what makes a provision
   survive a redeploy — the gap the old `forkDetach` fiber had.
2. **Poll loop.** Every `pollMs`, claim due jobs (`pending` with
   `next_attempt_at <= now`) and run them.
3. **One outcome contract.** Handlers return `done | retry | dead`; the
   runner owns backoff (`retryScheduleMs`), `maxAttempts`, and dead-lettering.
   Handlers never write their own loop.

A handler advances by writing `job_steps` checkpoints *before* each
side-effecting call, so a crash leaves a resumable checkpoint, never a
phantom. On resume the handler skips steps already `done`.

## The two handlers

- **`provision`** — the app-creation saga (repo → oidc → deploy → router →
  directory, plus optional database/r2). It reuses the `Scaffold.create`
  pipeline and checkpoints coarse step progress around it. `Scaffold.create`
  runs as one idempotent pipeline, so on resume it re-enters and re-runs up to
  the failed step; the checkpoint is what the stepper + reaper read.
- **`deliver_webhook`** — POST the envelope (in `payload`) to the app's
  `/hooks/platform`, signed with the app's delivery secret. Failure
  classification (docs/events.md): transient → backoff, terminal 4xx → dead,
  429 → honor `Retry-After`.

## Adding a job kind

Register one handler in the registry; the table, drainer, retry policy, and
reaper come free. A future `prune_app` teardown saga or a preview-deploy job
is a handler, not a new subsystem.

## Configuration

The runner shares the events env knobs (`EVENTS_MAX_ATTEMPTS`,
`EVENTS_RETRY_SCHEDULE`, `EVENTS_POLL_MS`) with platform defaults; `staleMs`
(how long a `running` job may go untouched before the reaper claims it) is a
runner constant.
