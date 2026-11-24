import { asc, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as McpSchema from "effect/ai/McpSchema";
import { Database } from "../store/database.ts";
import { apps, directoryTools, type AppStatus } from "../store/schema.ts";

export interface DirectoryTool {
  readonly appName: string;
  readonly appUrl: string;
  readonly appStatus: AppStatus;
  readonly remoteName: string;
  readonly gatewayName: string;
  readonly descriptor: McpSchema.Tool;
  readonly discoveredAt: string;
  readonly stale: boolean;
}

const selection = {
  appName: directoryTools.appName,
  appUrl: apps.url,
  appStatus: apps.status,
  remoteName: directoryTools.remoteName,
  gatewayName: directoryTools.gatewayName,
  descriptor: directoryTools.descriptor,
  discoveredAt: directoryTools.discoveredAt,
  stale: directoryTools.stale,
};

export class Directory extends Context.Service<Directory, {
  readonly replaceForApp: (
    appName: string,
    tools: ReadonlyArray<McpSchema.Tool>,
    discoveredAt: string,
  ) => Effect.Effect<void>;
  readonly markStale: (appName: string) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<DirectoryTool>>;
  readonly find: (gatewayName: string) => Effect.Effect<Option.Option<DirectoryTool>>;
  readonly contains: (gatewayName: string) => Effect.Effect<boolean>;
  readonly search: (query: string) => Effect.Effect<ReadonlyArray<DirectoryTool>>;
}>()("@vibevarium/control-plane/discovery/Directory") {
  static readonly layer = Layer.effect(Directory)(Effect.gen(function*() {
    const { db } = yield* Database;

    const replaceForApp = Effect.fnUntraced(function*(
      appName: string,
      tools: ReadonlyArray<McpSchema.Tool>,
      discoveredAt: string,
    ) {
      yield* Effect.promise(() =>
        db.transaction(async (tx) => {
          await tx.delete(directoryTools).where(eq(directoryTools.appName, appName));
          if (tools.length === 0) return;
          await tx.insert(directoryTools).values(tools.map((tool) => ({
            appName,
            remoteName: tool.name,
            gatewayName: `${appName}_${tool.name}`,
            descriptor: tool,
            discoveredAt,
            stale: false,
          })));
        })
      );
    });

    const markStale = Effect.fnUntraced(function*(appName: string) {
      yield* Effect.promise(() =>
        db.update(directoryTools).set({ stale: true }).where(eq(directoryTools.appName, appName))
      );
    });

    const list = Effect.fnUntraced(function*() {
      return yield* Effect.promise(() =>
        db.select(selection).from(directoryTools).innerJoin(apps, eq(directoryTools.appName, apps.name)).orderBy(
          asc(directoryTools.gatewayName),
        )
      );
    });

    const find = Effect.fnUntraced(function*(gatewayName: string) {
      const rows = yield* Effect.promise(() =>
        db.select(selection).from(directoryTools).innerJoin(apps, eq(directoryTools.appName, apps.name)).where(
          eq(directoryTools.gatewayName, gatewayName),
        ).limit(1)
      );
      return Option.fromUndefinedOr(rows[0]);
    });

    const contains = Effect.fnUntraced(function*(gatewayName: string) {
      return Option.isSome(yield* find(gatewayName));
    });

    const search = Effect.fnUntraced(function*(query: string) {
      const needle = query.trim().toLowerCase();
      const tools = yield* list();
      if (needle === "") return tools;
      return tools.filter((tool) =>
        `${tool.gatewayName} ${tool.remoteName} ${tool.appName} ${tool.descriptor.description ?? ""}`
          .toLowerCase().includes(needle)
      );
    });

    return Directory.of({ replaceForApp, markStale, list, find, contains, search });
  }));
}
