/**
 * The `control` CLI subtree: the platform's own control surface, agent- and
 * human-callable from the same binary that drives fleet apps.
 *
 * `control` is a RESERVED alias — fleet apps are never named `control` (the
 * control plane's scaffold/provision/registration routes reject it), so this
 * subtree unambiguously means "the platform control plane."
 *
 * These are plain typed HTTP calls to the control plane's ops routes
 * (/apps, /provisioning, /previews) with the same SSO bearer the composed app
 * CLIs use (requireSession from auth.ts). The base URL is
 * PLATFORM_CONTROL_PLANE_URL (default https://platform.vibevarium.com); auth
 * config is the same OIDC issuer/audience as `platform login`.
 */
import * as CliError from "effect/cli/CliError";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { requireSession } from "./auth.ts";
import { controlPlaneUrl } from "./config.ts";

const userError = (message: string, cause: unknown = message) =>
  new CliError.UserError({ cause, userMessage: message });

/** GET/POST/DELETE against the control plane with the cached SSO bearer attached. */
const controlRequest = Effect.fnUntraced(function* (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) {
  const session = yield* requireSession;
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.make(method)(`${controlPlaneUrl}${path}`);
  const withAuth = HttpClientRequest.setHeader(
    base,
    "Authorization",
    `${session.tokenType} ${session.accessToken}`,
  );
  const resolved = body === undefined
    ? withAuth
    : yield* HttpClientRequest.bodyJson(withAuth, body).pipe(
        Effect.mapError((cause) => userError(`Could not encode request body: ${String(cause)}`)),
      );
  const response = yield* client.execute(resolved).pipe(
    Effect.mapError((cause) => userError(`Control plane request failed: ${String(cause)}`)),
  );
  const text = yield* response.text.pipe(
    Effect.mapError((cause) => userError(`Could not read control plane response: ${String(cause)}`)),
  );
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    return yield* userError(`Control plane returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (response.status >= 400) {
    const detail =
      typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${response.status}`;
    return yield* userError(`Control plane error (${method} ${path}): ${detail}`);
  }
  return json;
});

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const appNameArg = Argument.String("app").pipe(
  Argument.withSchema(Schema.String.check(Schema.isPattern(dnsLabel))),
  Argument.withDescription("App name (lower-kebab-case)"),
);

// ---------------------------------------------------------------------------
// control apps …
// ---------------------------------------------------------------------------
const appsList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const json = yield* controlRequest("GET", "/apps");
    yield* printJson(json);
  }),
).pipe(Command.withDescription("List registered apps on the control plane"));

const apps = Command.make("apps").pipe(
  Command.withSubcommands([appsList]),
  Command.withDescription("Control-plane app registry operations"),
);

// ---------------------------------------------------------------------------
// control provision …
// ---------------------------------------------------------------------------
const provision = Command.make(
  "provision",
  {
    name: Argument.String("name").pipe(
      Argument.withSchema(Schema.String.check(Schema.isPattern(dnsLabel))),
      Argument.withDescription("DNS-label-safe lower-kebab-case app name (`control` is reserved)"),
    ),
    target: Flag.optional(
      Flag.ChoiceWithValue("target", [
        ["cloudflare", "cloudflare"],
        ["aws", "aws"],
      ] as const),
    ).pipe(Flag.withDescription("Deploy target (default: the control plane's default)")),
    database: Flag.optional(
      Flag.ChoiceWithValue("database", [
        ["cf-d1", "cf-d1"],
        ["planetscale-hyperdrive", "planetscale-hyperdrive"],
      ] as const),
    ).pipe(Flag.withDescription("Database option (default: the control plane's default)")),
    feature: Flag.optional(Flag.String("feature")).pipe(
      Flag.withDescription("Feature flag, e.g. r2 or hyperdrive (repeatable via comma list)"),
    ),
  },
  ({ name, target, database, feature }) =>
    Effect.gen(function* () {
      const features = Option.match(feature, {
        onNone: () => [] as ReadonlyArray<string>,
        onSome: (value) => value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
      });
      const body: Record<string, unknown> = { name, features };
      if (Option.isSome(target)) body["target"] = target.value;
      if (Option.isSome(database)) body["database"] = database.value;
      const json = yield* controlRequest("POST", "/provisioning", body);
      yield* printJson(json);
    }),
).pipe(
  Command.withDescription("Start an app provision job; returns a jobId to poll with `control job <id>`"),
);

// ---------------------------------------------------------------------------
// control previews / history / job …
// ---------------------------------------------------------------------------
const appNameFlag = () =>
  Flag.String("app").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(dnsLabel))),
  );

const previews = Command.make(
  "previews",
  {
    app: Flag.optional(appNameFlag()).pipe(
      Flag.withDescription("Parent app name; omit for every preview on the platform"),
    ),
  },
  ({ app }) =>
    Effect.gen(function* () {
      const query = Option.isSome(app) ? `?app=${encodeURIComponent(app.value)}` : "";
      const json = yield* controlRequest("GET", `/previews${query}`);
      yield* printJson(json);
    }),
).pipe(Command.withDescription("List preview apps (all, or one parent's with --app)"));

const history = Command.make("history", { app: appNameArg }, ({ app }) =>
  Effect.gen(function* () {
    const json = yield* controlRequest("GET", `/apps/${encodeURIComponent(app)}/history`);
    yield* printJson(json);
  }),
).pipe(Command.withDescription("Deploy history for an app (provision jobs, newest first)"));

const job = Command.make(
  "job",
  {
    jobId: Argument.String("jobId").pipe(Argument.withDescription("Provision job id")),
  },
  ({ jobId }) =>
    Effect.gen(function* () {
      const json = yield* controlRequest("GET", `/provisioning/${encodeURIComponent(jobId)}`);
      yield* printJson(json);
    }),
).pipe(Command.withDescription("Provision job status by jobId"));

// ---------------------------------------------------------------------------
// control events … (docs/internal/events.md)
// ---------------------------------------------------------------------------
const eventsSources = Command.make("sources", {}, () =>
  Effect.gen(function* () {
    const json = yield* controlRequest("GET", "/events/sources");
    yield* printJson(json);
  }),
).pipe(Command.withDescription("List registered webhook sources on the control plane"));

const eventsSubscriptions = Command.make(
  "subscriptions",
  {
    app: Flag.optional(appNameFlag()).pipe(Flag.withDescription("App name to narrow by")),
    source: Flag.optional(Flag.String("source")).pipe(Flag.withDescription("Source name to narrow by")),
  },
  ({ app, source }) =>
    Effect.gen(function* () {
      const params = new URLSearchParams();
      if (Option.isSome(app)) params.set("app", app.value);
      if (Option.isSome(source)) params.set("source", source.value);
      const query = params.size === 0 ? "" : `?${params.toString()}`;
      const json = yield* controlRequest("GET", `/events/subscriptions${query}`);
      yield* printJson(json);
    }),
).pipe(Command.withDescription("List event subscriptions (all, or narrowed with --app/--source)"));

const eventsSubscribe = Command.make(
  "subscribe",
  {
    app: appNameArg,
    source: Argument.String("source").pipe(Argument.withDescription("Source name (e.g. github, stripe)")),
    eventType: Flag.optional(Flag.String("event-type")).pipe(
      Flag.withDescription("Provider event type to receive (comma list; default all)"),
    ),
    scope: Flag.optional(Flag.String("scope")).pipe(
      Flag.withDescription("Repo/account scope (comma list; default all)"),
    ),
  },
  ({ app, source, eventType, scope }) =>
    Effect.gen(function* () {
      const body: Record<string, unknown> = { app, source };
      if (Option.isSome(eventType)) {
        body["eventTypes"] = eventType.value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
      }
      if (Option.isSome(scope)) {
        body["scopes"] = scope.value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
      }
      const json = yield* controlRequest("POST", "/events/subscriptions", body);
      yield* printJson(json);
    }),
).pipe(Command.withDescription("Subscribe an app to a webhook source (docs/internal/events.md)"));

const eventsUnsubscribe = Command.make(
  "unsubscribe",
  { id: Argument.String("id").pipe(Argument.withDescription("Subscription id")) },
  ({ id }) =>
    Effect.gen(function* () {
      const json = yield* controlRequest("DELETE", `/events/subscriptions/${encodeURIComponent(id)}`);
      yield* printJson(json);
    }),
).pipe(Command.withDescription("Remove an event subscription by id"));

const eventsDeliveries = Command.make(
  "deliveries",
  {
    subscription: Flag.optional(Flag.String("subscription")).pipe(Flag.withDescription("Subscription id to narrow by")),
    status: Flag.optional(Flag.String("status")).pipe(Flag.withDescription("pending | running | succeeded | failed | dead")),
  },
  ({ subscription, status }) =>
    Effect.gen(function* () {
      const params = new URLSearchParams();
      if (Option.isSome(subscription)) params.set("subscriptionId", subscription.value);
      if (Option.isSome(status)) params.set("status", status.value);
      const query = params.size === 0 ? "" : `?${params.toString()}`;
      const json = yield* controlRequest("GET", `/events/deliveries${query}`);
      yield* printJson(json);
    }),
).pipe(Command.withDescription("List recent event deliveries (fan-out debugging)"));

const events = Command.make("events").pipe(
  Command.withSubcommands([eventsSources, eventsSubscriptions, eventsSubscribe, eventsUnsubscribe, eventsDeliveries]),
  Command.withDescription("Central webhook firehose: sources, subscriptions, deliveries (docs/internal/events.md)"),
);

// ---------------------------------------------------------------------------
// The reserved `control` subtree.
// ---------------------------------------------------------------------------
export const control = Command.make("control").pipe(
  Command.withSubcommands([apps, provision, previews, history, job, events]),
  Command.withDescription(
    "The platform control plane (reserved alias — fleet apps are never named `control`). " +
      `Talking to ${controlPlaneUrl}`,
  ),
);
