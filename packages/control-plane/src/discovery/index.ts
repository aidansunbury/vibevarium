import { McpClient, McpProtocol } from "effect/ai";
import type * as McpClientError from "effect/ai/McpClientError";
import type * as McpSchema from "effect/ai/McpSchema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { describeClientError } from "../mcp.ts";
import { Registry, type AppRegistration } from "../registry/index.ts";
import { Directory } from "./directory.ts";

export interface DiscoverySuccess {
  readonly name: string;
  readonly status: "up";
  readonly toolCount: number;
  readonly discoveredAt: string;
}

export interface DiscoveryFailure {
  readonly name: string;
  readonly status: "down";
  readonly error: {
    readonly _tag: string;
    readonly message: string;
  };
  readonly retainedToolCount: number;
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure;

type RemoteResult =
  | { readonly _tag: "ok"; readonly tools: ReadonlyArray<McpSchema.Tool> }
  | { readonly _tag: "error"; readonly error: { readonly _tag: string; readonly message: string } };

export class Discovery extends Context.Service<Discovery, {
  readonly discoverApp: (app: AppRegistration) => Effect.Effect<DiscoveryResult>;
  readonly discoverAll: () => Effect.Effect<ReadonlyArray<DiscoveryResult>>;
}>()("@vibevarium/control-plane/discovery/Discovery") {
  static readonly layer = (options: {
    readonly timeoutMs: number;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    /** Mint a fresh bearer token per app-discovery run (M2M client credentials). Wins over `headers`. */
    readonly token?: Effect.Effect<string, never, never> | undefined;
  readonly protocol?: McpProtocol.ProtocolAdapter<"2025-11-25" | "2026-07-28"> | undefined;
  }) =>
    Layer.effect(Discovery)(Effect.gen(function*() {
      const registry = yield* Registry;
      const directory = yield* Directory;
      const httpClient = yield* HttpClient.HttpClient;

      const discoverApp = Effect.fnUntraced(function*(app: AppRegistration) {
        const tokenHeaders = options.token === undefined
          ? undefined
          : { authorization: `Bearer ${yield* options.token.pipe(Effect.orElseSucceed(() => ""))}` };
        const remote = yield* Effect.gen(function*() {
          const client = yield* McpClient.McpClient;
          const tools = yield* client.listTools({ timeout: options.timeoutMs });
          return { _tag: "ok", tools } as const;
        }).pipe(
          Effect.provide(McpClient.layerHttp({
            name: "vibevarium-discovery",
            version: "0.0.1",
            url: app.url,
            protocol: options.protocol ?? McpProtocol.v2025_11_25,
            ...options.headers === undefined ? {} : { headers: options.headers },
            ...tokenHeaders === undefined ? {} : { headers: tokenHeaders },
            timeout: options.timeoutMs,
          })),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.scoped,
          Effect.catch((error: McpClientError.McpClientError): Effect.Effect<RemoteResult> =>
            Effect.succeed({ _tag: "error", error: describeClientError(error) })
          ),
          Effect.timeoutOrElse({
            duration: options.timeoutMs,
            orElse: (): Effect.Effect<RemoteResult> =>
              Effect.succeed({
                _tag: "error",
                error: { _tag: "TimeoutError", message: `Discovery exceeded ${options.timeoutMs}ms` },
              }),
          }),
        );

        if (remote["_tag"] === "error") {
          yield* directory.markStale(app.name);
          yield* registry.markDown(app.name, `${remote.error["_tag"]}: ${remote.error.message}`);
          const retained = yield* directory.list();
          return {
            name: app.name,
            status: "down",
            error: remote.error,
            retainedToolCount: retained.filter((tool) => tool.appName === app.name).length,
          } satisfies DiscoveryFailure;
        }

        const discoveredAt = DateTime.formatIso(yield* DateTime.now);
        yield* directory.replaceForApp(app.name, remote.tools, discoveredAt);
        yield* registry.markUp(app.name, discoveredAt);
        return {
          name: app.name,
          status: "up",
          toolCount: remote.tools.length,
          discoveredAt,
        } satisfies DiscoverySuccess;
      });

      const discoverAll = Effect.fnUntraced(function*() {
        const registered = yield* registry.list();
        return yield* Effect.forEach(registered, discoverApp, { concurrency: "unbounded" });
      });

      return Discovery.of({ discoverApp, discoverAll });
    }));
}

export { Directory } from "./directory.ts";
export type { DirectoryTool } from "./directory.ts";
