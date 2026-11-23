import { McpSchema, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Directory, type DirectoryTool } from "../discovery/directory.ts";
import { Registry } from "../registry/index.ts";
import { toolFields } from "../tool-descriptor.ts";
import { AppProxy } from "./proxy.ts";

export const DIRECTORY_LIST_APPS = "directory_list_apps";
export const DIRECTORY_SEARCH_TOOLS = "directory_search_tools";
const directoryToolNames = new Set([DIRECTORY_LIST_APPS, DIRECTORY_SEARCH_TOOLS]);

/**
 * Reserved control-plane tools (`control_*`) — the platform's own control
 * surface exposed to agents. Registered in control-tools.ts alongside the
 * directory tools; listed here so the visibility middleware keeps them
 * always-visible (they are not per-app directory rows).
 */
export const CONTROL_TOOL_PREFIX = "control_";

export const namespaceTool = (record: DirectoryTool) =>
  new McpSchema.Tool({
    ...toolFields(record.descriptor),
    name: record.gatewayName,
    ["_meta"]: {
      ...record.descriptor["_meta"],
      "terrarium/app": record.appName,
      "terrarium/stale": record.stale,
    },
  });

const jsonResult = (value: unknown, isError = false) =>
  new McpSchema.CallToolResult({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  });

const decodeArguments = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
const invalidArguments = (cause: Schema.SchemaError) => new McpSchema.InvalidParams({ message: cause.message });

const callerHeaders = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({
    onNone: () => Headers.empty,
    onSome: (request) => request.headers,
  }),
);

export const syncGatewayTools = Effect.gen(function*() {
  const server = yield* McpServer.McpServer;
  const directory = yield* Directory;
  const proxy = yield* AppProxy;
  const records = yield* directory.list();

  for (const record of records) {
    yield* server.addTool({
      tool: namespaceTool(record),
      annotations: Context.empty(),
      handle: (payload: unknown) =>
        Effect.gen(function*() {
          const args = yield* decodeArguments(payload).pipe(Effect.mapError(invalidArguments));
          const headers = yield* callerHeaders;
          return yield* proxy.call(record.gatewayName, args, headers);
        }),
    });
  }
});

export const registerDirectoryTools = Effect.gen(function*() {
  const server = yield* McpServer.McpServer;
  const registry = yield* Registry;
  const directory = yield* Directory;

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: DIRECTORY_LIST_APPS,
      description: "List registered apps, their URLs, discovery status, and last-known timestamps.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: () => Effect.map(registry.list(), (apps) => jsonResult({ apps })),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: DIRECTORY_SEARCH_TOOLS,
      description: "Search last-known app tools by app, tool name, or description. Includes stale tools from down apps.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Case-insensitive substring to search for." } },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Effect.gen(function*() {
        const { query } = yield* Schema.decodeUnknownEffect(Schema.Struct({ query: Schema.String }))(payload).pipe(
          Effect.mapError(invalidArguments),
        );
        const tools = yield* directory.search(query);
        return jsonResult({
          tools: tools.map((tool) => ({
            app: tool.appName,
            appStatus: tool.appStatus,
            stale: tool.stale,
            discoveredAt: tool.discoveredAt,
            tool: toolFields(namespaceTool(tool)),
          })),
        });
      }),
  });
});

/** addTool has no removal API: visibility makes the current directory rows authoritative on every list/call. */
export const directoryVisibility = McpServer.visibility(
  Effect.gen(function*() {
    const directory = yield* Directory;
    return ({ target }: McpServer.MiddlewareOptions) =>
      directoryToolNames.has(target) || target.startsWith(CONTROL_TOOL_PREFIX)
        ? Effect.succeed(true)
        : directory.contains(target);
  }),
  { global: true },
);

export const gatewayRegistrations = Layer.mergeAll(
  directoryVisibility,
  Layer.effectDiscard(registerDirectoryTools),
  Layer.effectDiscard(syncGatewayTools),
);
