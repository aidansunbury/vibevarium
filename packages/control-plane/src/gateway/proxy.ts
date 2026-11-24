import { McpClient, McpProtocol } from "effect/ai";
import type * as McpClientError from "effect/ai/McpClientError";
import * as McpSchema from "effect/ai/McpSchema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Directory } from "../discovery/directory.ts";
import { describeClientError, forwardedHeaders } from "../mcp.ts";
import { Registry } from "../registry/index.ts";
import { toolFields } from "../tool-descriptor.ts";

export type GatewayErrorTag = "ToolNotFound" | "AppNotRegistered" | "AppUnavailable" | "AppTimeout";

const errorResult = (
  tag: GatewayErrorTag,
  appName: string,
  gatewayName: string,
  message: string,
  cause?: { readonly _tag: string; readonly message: string },
) => {
  const error = { _tag: tag, app: appName, tool: gatewayName, message, ...(cause === undefined ? {} : { cause }) };
  return new McpSchema.CallToolResult({
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    structuredContent: { error },
    isError: true,
  });
};

export class AppProxy extends Context.Service<AppProxy, {
  readonly call: (
    gatewayName: string,
    args: Readonly<Record<string, unknown>>,
    callerHeaders: Headers.Headers,
  ) => Effect.Effect<McpSchema.CallToolResult>;
}>()("@vibevarium/control-plane/gateway/AppProxy") {
  static readonly layer = (options: { readonly timeoutMs: number }) =>
    Layer.effect(AppProxy)(Effect.gen(function*() {
      const directory = yield* Directory;
      const registry = yield* Registry;
      const httpClient = yield* HttpClient.HttpClient;

      const call = Effect.fnUntraced(function*(
        gatewayName: string,
        args: Readonly<Record<string, unknown>>,
        callerHeaders: Headers.Headers,
      ) {
        const separator = gatewayName.indexOf("_");
        const parsed = separator < 1 ? undefined : {
          appName: gatewayName.slice(0, separator),
          remoteName: gatewayName.slice(separator + 1),
        };
        const found = yield* directory.find(gatewayName);
        if (Option.isNone(found) || parsed === undefined) {
          return errorResult("ToolNotFound", parsed?.appName ?? "unknown", gatewayName, "Tool is not in the directory");
        }
        const record = found.value;
        if (record.appName !== parsed.appName || record.remoteName !== parsed.remoteName) {
          return errorResult("ToolNotFound", record.appName, gatewayName, "Namespaced tool name does not match the directory");
        }
        const app = yield* registry.get(record.appName);
        if (Option.isNone(app)) {
          return errorResult("AppNotRegistered", record.appName, gatewayName, "The owning app is not registered");
        }

        return yield* Effect.gen(function*() {
          const client = yield* McpClient.McpClient;
          return yield* client.callTool({
            tool: new McpSchema.Tool({ ...toolFields(record.descriptor), name: record.remoteName }),
            arguments: args,
          }, { timeout: options.timeoutMs });
        }).pipe(
          Effect.provide(McpClient.layerHttp({
            name: "vibevarium-gateway",
            version: "0.0.1",
            url: app.value.url,
            protocol: new URL(app.value.url).hostname.endsWith(".workers.dev")
              ? McpProtocol.v2026_07_28
              : McpProtocol.v2025_11_25,
            headers: forwardedHeaders(callerHeaders),
            timeout: options.timeoutMs,
          })),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.scoped,
          Effect.catch((error: McpClientError.McpClientError) => {
            const cause = describeClientError(error);
            return Effect.succeed(errorResult(
              cause["_tag"] === "TimeoutError" ? "AppTimeout" : "AppUnavailable",
              record.appName,
              gatewayName,
              `Could not call ${record.appName}: ${cause.message}`,
              cause,
            ));
          }),
          Effect.timeoutOrElse({
            duration: options.timeoutMs,
            orElse: () =>
              Effect.succeed(errorResult(
                "AppTimeout",
                record.appName,
                gatewayName,
                `Call to ${record.appName} exceeded ${options.timeoutMs}ms`,
              )),
          }),
        );
      });

      return AppProxy.of({ call });
    }));
}
