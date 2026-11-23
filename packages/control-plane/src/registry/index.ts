import { asc, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Database } from "../store/database.ts";
import { apps, type AppRow, type AppStatus } from "../store/schema.ts";

export type AppRegistration = AppRow;

export const RegisterAppInput = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  oidcClientId: Schema.optional(Schema.String),
});
export type RegisterAppInput = typeof RegisterAppInput.Type;

export class Registry extends Context.Service<Registry, {
  readonly register: (input: RegisterAppInput) => Effect.Effect<AppRegistration>;
  readonly list: () => Effect.Effect<ReadonlyArray<AppRegistration>>;
  readonly get: (name: string) => Effect.Effect<Option.Option<AppRegistration>>;
  readonly remove: (name: string) => Effect.Effect<void>;
  readonly markUp: (name: string, seenAt: string) => Effect.Effect<void>;
  readonly markDown: (name: string, error: string) => Effect.Effect<void>;
  readonly setStatus: (name: string, status: AppStatus) => Effect.Effect<void>;
}>()("@terrarium/control-plane/registry/Registry") {
  static readonly layer = Layer.effect(Registry)(Effect.gen(function*() {
    const { db } = yield* Database;

    const register = Effect.fnUntraced(function*(input: RegisterAppInput) {
      const rows = yield* Effect.promise(() =>
        db.insert(apps).values(input).onConflictDoUpdate({
          target: apps.name,
          set: { url: input.url, oidcClientId: input.oidcClientId },
        }).returning()
      );
      return rows[0];
    });

    const list = Effect.fnUntraced(function*() {
      return yield* Effect.promise(() => db.select().from(apps).orderBy(asc(apps.name)));
    });

    const get = Effect.fnUntraced(function*(name: string) {
      const rows = yield* Effect.promise(() => db.select().from(apps).where(eq(apps.name, name)).limit(1));
      return Option.fromUndefinedOr(rows[0]);
    });

    const remove = Effect.fnUntraced(function*(name: string) {
      yield* Effect.promise(() => db.delete(apps).where(eq(apps.name, name)));
    });

    const markUp = Effect.fnUntraced(function*(name: string, seenAt: string) {
      yield* Effect.promise(() =>
        db.update(apps).set({
          status: "up",
          lastSeenAt: seenAt,
          lastCheckedAt: seenAt,
          lastError: null,
        }).where(eq(apps.name, name))
      );
    });

    const markDown = Effect.fnUntraced(function*(name: string, error: string) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.promise(() =>
        db.update(apps).set({ status: "down", lastCheckedAt: checkedAt, lastError: error }).where(
          eq(apps.name, name),
        )
      );
    });

    const setStatus = Effect.fnUntraced(function*(name: string, status: AppStatus) {
      yield* Effect.promise(() => db.update(apps).set({ status }).where(eq(apps.name, name)));
    });

    return Registry.of({ register, list, get, remove, markUp, markDown, setStatus });
  }));
}
