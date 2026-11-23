/**
 * Control-plane MCP tools: the platform's own control surface, exposed as
 * agent-callable meta-MCP tools alongside the directory tools.
 *
 * These are the control plane eating its own dogfood — the same operations the
 * ops HTTP routes and the `control` CLI subtree drive, callable by any MCP
 * agent with a platform bearer/M2M token (the gateway's /mcp endpoint already
 * sits behind that auth).
 *
 * RESERVED ALIAS: `control` is the platform's control-surface alias and must
 * never be a fleet app name. The scaffold/provision/registry routes reject the
 * name `control` (see RESERVED_APP_NAME in ../reserved.ts).
 */
import { McpSchema, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Acl } from "../acl/index.ts";
import { Provisioning, ProvisionSpec } from "../provisioning/index.ts";
import { Registry } from "../registry/index.ts";
import { RESERVED_APP_NAME } from "../reserved.ts";
import { DIRECTORY_LIST_APPS } from "./tools.ts";

export const CONTROL_LIST_APPS = "control_list_apps";
export const CONTROL_LIST_PREVIEWS = "control_list_previews";
export const CONTROL_PROVISION_APP = "control_provision_app";
export const CONTROL_JOB_STATUS = "control_job_status";
export const CONTROL_APP_HISTORY = "control_app_history";
export const CONTROL_PREVIEWS = "control_previews";
export const CONTROL_GET_ACL = "control_get_acl";

/** Control tools are always visible (they are not per-app directory rows). */
export const controlToolNames = new Set([
  CONTROL_LIST_APPS,
  CONTROL_LIST_PREVIEWS,
  CONTROL_PROVISION_APP,
  CONTROL_JOB_STATUS,
  CONTROL_APP_HISTORY,
  CONTROL_PREVIEWS,
  CONTROL_GET_ACL,
]);

const jsonResult = (value: unknown, isError = false) =>
  new McpSchema.CallToolResult({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  });

const errorResult = (message: string) => jsonResult({ error: { message } }, true);

const invalidArguments = (cause: Schema.SchemaError) =>
  new McpSchema.InvalidParams({ message: cause.message });

const appNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
);

/**
 * Register the control-plane tools. Same registration pattern as
 * registerDirectoryTools: added to the meta-MCP server once at boot; auth is
 * whatever the gateway /mcp endpoint already enforces (platform bearer/M2M).
 */
export const registerControlTools = Effect.gen(function*() {
  const server = yield* McpServer.McpServer;
  const registry = yield* Registry;
  const provisioning = yield* Provisioning;
  // Captured at registration (handlers can't see services beyond the MCP
  // runtime). Option so a server build without the Acl layer still answers
  // control_get_acl with registry state — the seam stays clean.
  const aclOption = yield* Effect.serviceOption(Acl);

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: CONTROL_LIST_APPS,
      description:
        "List registered apps on the platform (name, URL, status, preview lineage, last-known timestamps). Control-plane view of the fleet; same data as directory_list_apps.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: () => Effect.map(registry.list(), (apps) => jsonResult({ apps })),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: CONTROL_LIST_PREVIEWS,
      description:
        "List every preview app on the platform (all parents), or one parent's previews when `app` is given.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "Parent app name; omit for all previews." },
        },
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Effect.gen(function*() {
        const { app } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ app: Schema.optional(appNameSchema) }),
        )(payload).pipe(Effect.mapError(invalidArguments));
        const previews = yield* provisioning.previews(app);
        return jsonResult({ previews });
      }),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: CONTROL_PROVISION_APP,
      description:
        "Start an app provision job (repo → OIDC client → deploy → router → directory → discovery). Returns a jobId; poll control_job_status for progress. The name `" +
        RESERVED_APP_NAME +
        "` is reserved for the platform control surface and is rejected.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "DNS-label-safe lower-kebab-case app name." },
          target: { type: "string", enum: ["cloudflare", "aws"] },
          database: { type: "string", enum: ["cf-d1", "planetscale-hyperdrive"] },
          features: { type: "array", items: { type: "string", enum: ["r2", "hyperdrive"] } },
          previewOf: { type: "string", description: "Parent app name when this is a PR preview." },
          previewPr: { type: "string", description: "PR number (previews only)." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Effect.gen(function*() {
        const spec = yield* Schema.decodeUnknownEffect(ProvisionSpec)(payload).pipe(
          Effect.mapError(invalidArguments),
        );
        return yield* provisioning.start(spec).pipe(
          Effect.map((started) => jsonResult(started)),
          Effect.catch((error) => Effect.succeed(errorResult(error.message))),
        );
      }),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: CONTROL_JOB_STATUS,
      description: "Get a provision job's status and step states by jobId.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", description: "Job id from control_provision_app." } },
        required: ["jobId"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Effect.gen(function*() {
        const { jobId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ jobId: Schema.String }))(
          payload,
        ).pipe(Effect.mapError(invalidArguments));
        return yield* provisioning.get(jobId).pipe(
          Effect.map((status) => jsonResult(status)),
          Effect.catch((error) => Effect.succeed(errorResult(error.message))),
        );
      }),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: CONTROL_APP_HISTORY,
      description: "Deploy history for an app: every provision job, newest first (previews included).",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "App name." } },
        required: ["app"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Effect.gen(function*() {
        const { app } = yield* Schema.decodeUnknownEffect(Schema.Struct({ app: appNameSchema }))(
          payload,
        ).pipe(Effect.mapError(invalidArguments));
        const history = yield* provisioning.history(app);
        return jsonResult({ history });
      }),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: CONTROL_PREVIEWS,
      description: "Previews for a parent app (name, PR, URL, status).",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "Parent app name." } },
        required: ["app"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Effect.gen(function*() {
        const { app } = yield* Schema.decodeUnknownEffect(Schema.Struct({ app: appNameSchema }))(
          payload,
        ).pipe(Effect.mapError(invalidArguments));
        const previews = yield* provisioning.previews(app);
        return jsonResult({ previews });
      }),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: CONTROL_GET_ACL,
      description:
        "App access-control view (docs/previews-and-acl.md): visibility (internal|restricted), the creator seed, and the member list. Reads the control plane's ACL policy rows; enforcement lives at the app/router/gateway at request time. When the app predates the ACL store, the internal default applies (any platform user passes).",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "App name." } },
        required: ["app"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Effect.gen(function*() {
        const { app } = yield* Schema.decodeUnknownEffect(Schema.Struct({ app: appNameSchema }))(
          payload,
        ).pipe(Effect.mapError(invalidArguments));
        if (Option.isNone(aclOption)) {
          // SEAM: the Acl service isn't in this server's layer graph yet —
          // fall back to registry state so the tool still answers.
          const record = yield* registry.get(app);
          return jsonResult({
            app,
            registered: record._tag === "Some",
            acl: undefined,
            note: "ACL service not available on this control plane; showing registry state only",
          });
        }
        const acl = aclOption.value;
        const view = yield* acl.getAcl(app);
        const members = yield* acl.listMembers(app);
        const current = Option.getOrElse(view, () => ({
          app,
          visibility: "internal" as const,
          createdBy: null,
        }));
        return jsonResult({
          app: current.app,
          visibility: current.visibility,
          createdBy: current.createdBy,
          members,
        });
      }),
  });
});

export const controlToolsRegistration = Layer.effectDiscard(registerControlTools);

/** Keep DIRECTORY_LIST_APPS referenced so the two tool families stay adjacent. */
void DIRECTORY_LIST_APPS;
