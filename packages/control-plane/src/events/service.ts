/**
 * Events (docs/internal/events.md): the control plane's central webhook firehose.
 *
 * Providers POST their whole event stream once to `/events/:source` (verified
 * against a per-source secret resolved through the SecretsProvider seam). The
 * dispatcher normalizes each event into an envelope, finds every active
 * subscription whose structured match fits, and enqueues one durable
 * `deliver_webhook` job per (event, subscription). The JobRunner drains those
 * jobs and pushes to each app's `/hooks/platform` endpoint, signed with the
 * app's own delivery secret.
 *
 * Design anchors:
 * - Subscription truth lives in Postgres, never in a broker — the jobs table
 *   is the only v1 "queue", and it survives any future backend swap.
 * - Sources come from connections.config.ts. With an empty webhook catalog,
 *   `publish` fails with events_not_configured (503) so providers never get a
 *   false 200. Runtime DB rows hold only grants/subscriptions/deliveries.
 */
import { and, eq, type SQL } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { Database } from "../store/database.ts";
import {
  apps,
  eventSubscriptions,
  webhookSources,
  type EventFilterClause,
  type EventSubscriptionRow,
  type JobRow,
  type WebhookSourceRow,
} from "../store/schema.ts";
import { JobRunner } from "../jobs/index.ts";
import type { DeliverWebhookPayload } from "../jobs/handlers.ts";
import { SecretsProvider } from "../integrations/secrets.ts";
import { ConnectionsConfigService, type WebhookSourceConfig } from "../config/connections-schema.ts";

export class EventError extends Schema.TaggedError<EventError>()("EventError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

const fail = (status: number, code: string, message: string) =>
  Effect.fail(new EventError({ status, code, message }));

const toSourceView = (row: WebhookSourceRow, secretConfigured: boolean, definition?: WebhookSourceConfig): SourceView => ({
  name: row.name,
  displayName: definition?.displayName ?? row.displayName,
  ...(definition?.logoUrl === undefined ? {} : { logoUrl: definition.logoUrl }),
  secret: definition?.secret ?? row.secretRef,
  verification: row.verification,
  eventTypeHeader: row.eventTypeHeader,
  enabled: row.enabled,
  secretConfigured,
  createdAt: row.createdAt,
});

const toSubscriptionView = (row: EventSubscriptionRow, deliveryConfigured: boolean): SubscriptionView => ({
  id: row.id,
  app: row.app,
  source: row.source,
  eventTypes: row.eventTypes,
  scopes: row.scopes,
  filter: row.filter,
  status: row.status,
  deliveryConfigured,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});

// ---------------------------------------------------------------------------
// Views + inputs
// ---------------------------------------------------------------------------

export interface SourceView {
  readonly name: string;
  readonly displayName: string;
  readonly logoUrl?: string | undefined;
  /** Stable config slug for the ingress verification credential. */
  readonly secret: string;
  readonly verification: string;
  readonly eventTypeHeader: string | null;
  readonly enabled: boolean;
  readonly secretConfigured: boolean;
  readonly createdAt: string;
}

export interface SubscriptionView {
  readonly id: string;
  readonly app: string;
  readonly source: string;
  readonly eventTypes: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string>;
  readonly filter: ReadonlyArray<EventFilterClause> | null;
  readonly status: string;
  readonly deliveryConfigured: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export const CreateSubscriptionInput = Schema.Struct({
  app: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  source: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  eventTypes: Schema.optional(Schema.Array(Schema.String)),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  filter: Schema.optional(Schema.NullOr(Schema.Array(Schema.Any))),
  createdBy: Schema.optional(Schema.String),
});
export type CreateSubscriptionInput = typeof CreateSubscriptionInput.Type;

export interface NormalizedEvent {
  readonly source: string;
  readonly eventId: string | null;
  readonly eventType: string;
  /** Structured scope hints (repo, account) for Layer-1 narrowing. */
  readonly scopes: ReadonlyArray<string>;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Layer-2 filter evaluation (allowlisted predicate, ANDed).
// ---------------------------------------------------------------------------

const pathValue = (payload: unknown, path: string): unknown => {
  let current = payload;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const evalClause = (payload: unknown, clause: EventFilterClause): boolean => {
  const value = pathValue(payload, clause.path);
  switch (clause.op) {
    case "eq":
      return value === clause.value;
    case "neq":
      return value !== clause.value;
    case "prefix":
      return typeof value === "string" && typeof clause.value === "string" && value.startsWith(clause.value);
    case "in":
      return Array.isArray(clause.value) && clause.value.includes(value);
    case "exists":
      return value !== undefined;
    default:
      return false;
  }
};

const matchesFilter = (payload: unknown, filter: ReadonlyArray<EventFilterClause> | null): boolean =>
  filter === null || filter.every((clause) => evalClause(payload, clause));

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Events extends Context.Service<Events, {
  // Sources (platform-owned; superadmin-gated at the route).
  readonly listSources: () => Effect.Effect<ReadonlyArray<SourceView>>;
  readonly getSource: (name: string) => Effect.Effect<Option.Option<SourceView>>;
  // Subscriptions (app-owner/superadmin-gated at the route).
  readonly subscribe: (input: CreateSubscriptionInput) => Effect.Effect<SubscriptionView, EventError>;
  readonly unsubscribe: (id: string) => Effect.Effect<void, EventError>;
  readonly listSubscriptions: (opts: { app?: string; source?: string }) => Effect.Effect<ReadonlyArray<SubscriptionView>>;
  readonly setSubscriptionStatus: (id: string, status: "active" | "paused") => Effect.Effect<SubscriptionView, EventError>;
  // Ingress.
  readonly publish: (
    sourceName: string,
    event: NormalizedEvent,
  ) => Effect.Effect<{ matched: number; eventId: string }, EventError>;
  // Outbox read surface (GUI/CLI inspection + the delivery fiber).
  readonly listDeliveries: (opts: { subscriptionId?: string; status?: string; limit?: number }) => Effect.Effect<ReadonlyArray<JobRow>>;
}>()("@vibevarium/control-plane/events/Events") {
  static readonly layer = (options: {
    /** Undefined → NoopEventBus behavior on publish (events_not_configured). */
    readonly enabled: boolean;
  }) =>
    Layer.effect(Events)(Effect.gen(function*() {
      const { db } = yield* Database;
      const secrets = yield* SecretsProvider;
      const runner = yield* JobRunner;
      const connectionsConfig = yield* ConnectionsConfigService;
      const sourceDefinitions = new Map(Object.entries(connectionsConfig.config.webhooks));

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      for (const [name, definition] of sourceDefinitions) {
        const values = {
          displayName: definition.displayName,
          secretRef: connectionsConfig.secretRef(definition.secret)!,
          verification: definition.verification ?? "hmac-sha256",
          eventTypeHeader: definition.eventTypeHeader ?? null,
          enabled: true,
          updatedAt: new Date().toISOString(),
        };
        yield* Effect.promise(() =>
          db.insert(webhookSources).values({ name, ...values }).onConflictDoUpdate({
            target: webhookSources.name,
            set: values,
          })
        );
      }
      const sourceView = (row: WebhookSourceRow, secretConfigured: boolean) =>
        toSourceView(row, secretConfigured, sourceDefinitions.get(row.name));

      const listSources = Effect.fnUntraced(function*() {
        const rows = yield* Effect.promise(() => db.select().from(webhookSources));
        return yield* Effect.forEach(rows.filter((row) => sourceDefinitions.has(row.name)), (row) =>
          Effect.map(secrets.resolve(row.secretRef), (secret) => sourceView(row, Option.isSome(secret)))
        );
      });

      const getSource = Effect.fnUntraced(function*(name: string) {
        if (!sourceDefinitions.has(name)) return Option.none<SourceView>();
        const rows = yield* Effect.promise(() =>
          db.select().from(webhookSources).where(eq(webhookSources.name, name)).limit(1)
        );
        const row = rows[0];
        if (row === undefined) return Option.none<SourceView>();
        return Option.some(sourceView(row, Option.isSome(yield* secrets.resolve(row.secretRef))));
      });

      const subscriptionView = Effect.fnUntraced(function*(row: EventSubscriptionRow) {
        const ref = connectionsConfig.webhookDeliverySecretRef(row.app);
        const configured = ref !== undefined && Option.isSome(yield* secrets.resolve(ref));
        return toSubscriptionView(row, configured);
      });

      const subscribe = Effect.fnUntraced(function*(input: CreateSubscriptionInput) {
        // Only statically configured sources can receive subscriptions.
        if (!sourceDefinitions.has(input.source)) {
          return yield* fail(404, "unknown_source", `Source ${input.source} is not registered`);
        }
        const sourceRows = yield* Effect.promise(() =>
          db.select().from(webhookSources).where(eq(webhookSources.name, input.source)).limit(1)
        );
        const source = sourceRows[0];
        if (source === undefined) {
          return yield* fail(404, "unknown_source", `Source ${input.source} is not registered`);
        }
        if (!source.enabled) {
          return yield* fail(409, "source_disabled", `Source ${input.source} is disabled`);
        }
        // The app must exist in the registry (deliveries target its URL).
        const appRows = yield* Effect.promise(() =>
          db.select().from(apps).where(eq(apps.name, input.app)).limit(1)
        );
        if (appRows[0] === undefined) {
          return yield* fail(404, "unknown_app", `App ${input.app} is not registered`);
        }
        const deliverySecretRef = connectionsConfig.webhookDeliverySecretRef(input.app);
        if (deliverySecretRef === undefined) {
          return yield* fail(
            400,
            "delivery_credential_not_configured",
            `App ${input.app} has no webhook delivery credential in connections.config.ts`,
          );
        }
        const id = randomUUID();
        const createdAt = yield* nowIso;
        const rows = yield* Effect.promise(() =>
          db.insert(eventSubscriptions).values({
            id,
            app: input.app,
            source: input.source,
            eventTypes: input.eventTypes ?? [],
            scopes: input.scopes ?? [],
            filter: (input.filter ?? null) as ReadonlyArray<EventFilterClause> | null,
            deliverySecretRef,
            createdBy: input.createdBy ?? null,
            updatedAt: createdAt,
          }).returning()
        );
        const row = rows[0]!;
        return yield* subscriptionView(row);
      });

      const unsubscribe = Effect.fnUntraced(function*(id: string) {
        const rows = yield* Effect.promise(() =>
          db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, id)).returning()
        );
        if (rows[0] === undefined) {
          return yield* fail(404, "not_found", `Subscription ${id} does not exist`);
        }
      });

      const listSubscriptions = Effect.fnUntraced(function*(opts: { app?: string; source?: string }) {
        const conditions: Array<SQL> = [];
        if (opts.app !== undefined) conditions.push(eq(eventSubscriptions.app, opts.app));
        if (opts.source !== undefined) conditions.push(eq(eventSubscriptions.source, opts.source));
        const base = db.select().from(eventSubscriptions);
        const rows = yield* Effect.promise(() =>
          conditions.length === 0 ? base : base.where(and(...conditions))
        );
        return yield* Effect.forEach(rows, subscriptionView);
      });

      const setSubscriptionStatus = Effect.fnUntraced(function*(id: string, status: "active" | "paused") {
        const updatedAt = yield* nowIso;
        const rows = yield* Effect.promise(() =>
          db.update(eventSubscriptions).set({ status, updatedAt }).where(eq(eventSubscriptions.id, id)).returning()
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* fail(404, "not_found", `Subscription ${id} does not exist`);
        }
        return yield* subscriptionView(row);
      });

      const publish = Effect.fnUntraced(function*(sourceName: string, event: NormalizedEvent) {
        if (!options.enabled) {
          return yield* fail(
            503,
            "events_not_configured",
            "The events feature is not configured on this control plane (connections.config.ts) — the provider should retry/alert rather than treat this as delivered",
          );
        }
        if (!sourceDefinitions.has(sourceName)) {
          return yield* fail(404, "unknown_source", `Source ${sourceName} is not registered`);
        }
        const sourceRows = yield* Effect.promise(() =>
          db.select().from(webhookSources).where(eq(webhookSources.name, sourceName)).limit(1)
        );
        const source = sourceRows[0];
        if (source === undefined) {
          return yield* fail(404, "unknown_source", `Source ${sourceName} is not registered`);
        }
        if (!source.enabled) {
          return yield* fail(409, "source_disabled", `Source ${sourceName} is disabled`);
        }

        // Candidate subscriptions: active, for this source, and matching the
        // structured (Layer 1) fields. Payload filters apply after.
        const subs = yield* Effect.promise(() =>
          db.select().from(eventSubscriptions).where(
            and(eq(eventSubscriptions.source, sourceName), eq(eventSubscriptions.status, "active")),
          )
        );

        const eventId = event.eventId ?? randomUUID();
        const createdAt = yield* nowIso;
        const matched: Array<typeof eventSubscriptions.$inferSelect> = [];
        for (const sub of subs) {
          if (sub.eventTypes.length > 0 && !sub.eventTypes.includes(event.eventType)) continue;
          if (sub.scopes.length > 0 && !sub.scopes.some((scope) => event.scopes.includes(scope))) continue;
          if (!matchesFilter(event.payload, sub.filter)) continue;
          matched.push(sub);
        }

        // One durable deliver_webhook job per matched subscription. The wrapped
        // envelope (in the job payload) carries provenance + the raw payload;
        // the JobRunner's deliver_webhook handler signs and pushes it.
        for (const sub of matched) {
          const envelope = {
            id: eventId,
            source: sourceName,
            type: event.eventType,
            time: createdAt,
            subscriptionId: sub.id,
            payload: event.payload,
          };
          const payload: DeliverWebhookPayload = {
            subscriptionId: sub.id,
            envelope,
            eventId,
            source: sourceName,
            eventType: event.eventType,
          };
          yield* runner.enqueue({
            kind: "deliver_webhook",
            name: sub.app,
            payload: payload as unknown as Record<string, unknown>,
            steps: [{ stepId: "post", label: `POST ${sub.app}/hooks/platform` }],
          });
        }

        return { matched: matched.length, eventId };
      });

      // The outbox read surface reads the jobs table (kind = deliver_webhook).
      // subscriptionId / eventType / source are reconstructed from the payload.
      const listDeliveries = Effect.fnUntraced(function*(opts: {
        subscriptionId?: string;
        status?: string;
        limit?: number;
      }) {
        const rows = yield* runner.list({ kind: "deliver_webhook", ...(opts.status === undefined ? {} : { status: opts.status }), limit: opts.limit ?? 100 });
        return opts.subscriptionId === undefined
          ? rows
          : rows.filter((row) => (row.payload as unknown as DeliverWebhookPayload).subscriptionId === opts.subscriptionId);
      });

      return Events.of({
        listSources,
        getSource,
        subscribe,
        unsubscribe,
        listSubscriptions,
        setSubscriptionStatus,
        publish,
        listDeliveries,
      });
    }));
}
