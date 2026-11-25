# Events (the webhook firehose)

Providers send their whole event stream to the control plane **once**. Apps
subscribe centrally, and the control plane fans each event out to every
matching app. Apps never register webhook URLs with providers, never see the
provider's main webhook secret, and never write their own signature
verification.

## Why

- **One provider relationship instead of N.** One org-level webhook (GitHub),
  one endpoint (Stripe, capped at 16) owned by the platform replaces N per-app
  registrations — each of which would need provider admin rights, its own
  secret, its own verification code.
- **Centralize what vibe-coded apps can't be trusted to do.** Signature
  verification is security-critical; one audited ingress removes a whole
  vulnerability class instead of hoping N generated apps got HMAC right.
- **Resilience for flaky apps.** Apps go down and get redeployed constantly.
  The durable outbox + retries (and later, replay) mean "app was broken for
  three days" is a platform operation, not lost events.
- **The fleet becomes an ecosystem.** Apps subscribe by pattern without
  app-to-app coupling; the platform's own lifecycle events
  (`AppRegistered`/`AppDeregistered`) can ride the same bus.

## The shape

```
GitHub ──HMAC(source secret)──▶ POST /events/github  (control plane ingress)
                                    │ verify once, normalize envelope
                                    ▼
                      match subscriptions (Postgres)
                                    │ one outbox row per (event, subscription)
                                    ▼
              delivery fiber ──HMAC(app delivery secret)──▶ POST <app>/hooks/platform
```

- **Envelope.** The control plane wraps its own metadata (`id`, `source`,
  `type`, `time`, `subscriptionId`) around the **raw provider payload**. The
  app sees what was verified, not just that it was.
- **Two secret domains.** The source secret lives only in the control plane's
  SecretsProvider. Each app's delivery secret is generated at provisioning,
  delivered as the Worker secret `TERRARIUM_EVENTS_SECRET`, and used to sign
  platform→app deliveries (Standard Webhooks: `webhook-id`,
  `webhook-timestamp`, `webhook-signature: v1,<hex>` over
  `id.timestamp.body`). A compromised app yields nothing that forges provider
  traffic; rotating the source secret is a one-place change.

## Configuration (mirrors the OAuth provider setup)

A **source** is registered config: `(name, displayName, secretRef,
verification, eventTypeHeader)`. `secretRef` is a SecretsProvider *reference*
(env var name locally, SM name in prod) — the value is never stored. A source
exists once; apps then subscribe to it. `verification` is `hmac-sha256`
(GitHub `X-Hub-Signature-256`, Stripe `Stripe-Signature`), `bearer`, or
`none`.

The feature is **optional**. When `EVENTS_ENABLED` is not true the control
plane mounts a `NoopEventBus`: `POST /events/:source` returns **503
`events_not_configured`** (so providers retry/alert rather than get a false
200), and CRUD/MCP/CLI list empty state. Ingress always verifies the
signature first when a source with a secret exists, so an unauthenticated
caller can't probe whether the feature is on.

Env knobs: `EVENTS_ENABLED`, `EVENTS_MAX_ATTEMPTS` (default 8),
`EVENTS_RETRY_SCHEDULE` (default `30s,2m,10m,30m,2h,8h`), `EVENTS_POLL_MS`
(default 5000).

## Subscriptions

A **subscription** is `(app, source, eventTypes, scopes, filter)`:

- `eventTypes` — the provider's own taxonomy (`["push", "check_suite"]`);
  empty = all types from the source. Layer 1, indexed.
- `scopes` — structured narrowing (repos / accounts); empty = all. Layer 1.
- `filter` — optional payload predicate (Layer 2), an allowlisted
  non-Turing-complete clause set: `{ path, op: eq|neq|prefix|in|exists,
  value }` ANDed together. Evaluated after Layer 1 narrows candidates.

**Authorization:** app owners/admins (ACL `isAdmin`/`canAccess`) and
superadmins manage subscriptions; sources are superadmin-only. The app's
delivery-secret reference defaults to the convention
`APP_EVENTS_SECRET_<APP>` and resolves through the SecretsProvider seam.

## Delivery + retries

One durable `deliver_webhook` job per (event, subscription) — running on the
same JobRunner engine as provisioning (docs/jobs.md). The runner drains due
jobs and pushes the envelope to `<app url>/hooks/platform`, signed with the
app's delivery secret. Failure classification:

- **transient** (timeout, 5xx, connection error) → retry with backoff
- **terminal** (4xx other than 408/429) → dead-letter immediately
- **rate-limited** (429 + `Retry-After`) → reschedule per the header

Retry policy is platform-default (env), with nullable per-subscription
overrides (`max_attempts`, `retry_schedule`) — delivery policy is a platform
decision until an app makes a case. The jobs table is the delivery truth and
audit record; it survives any future backend swap (Svix, EventBridge) because
those would only replace what *drains* it.

## Surfaces

- **HTTP** — `POST /events/:source` (ingress); `POST/GET /events/sources`;
  `POST/GET/DELETE /events/subscriptions`; `GET /events/deliveries`.
- **GUI** — the Events page: sources, subscriptions, recent deliveries.
- **CLI** — `control events sources|subscriptions|subscribe|unsubscribe|deliveries`.
- **Template** — `POST /hooks/platform` in the app worker, verifying the
  platform signature before handing the envelope to the app's `onEvent`
  (off unless `TERRARIUM_EVENTS_SECRET` is set).

## Later (deliberately not v1)

- **Replay / backfill** — retention makes "redeliver what app X missed" a UX
  operation. Cheap to add later: keep events, add a replay route.
- **Event-level authorization** — scope subscription permission to the app's
  OAuth grants (least-privilege event access).
- **Payload projection** — deliver a minimized payload per subscription for
  sensitive providers.
- **A real bus behind the seam** — Svix (MIT, self-host) or AWS EventBridge
  (hosted ingress, retention) when volume/ops justify it. The metadata,
  envelope, and delivery contract don't change.
- **MCP tasks/subscriptions over the firehose** — agent-facing "wait for CI"
  as a durable tool call (SEP-2663 tasks + `subscriptions/listen`), with the
  polling loop in the harness. Deferred — not worth it yet.
