import { and, asc, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Database } from "../store/database.ts";
import { appOidcRegistrations, apps, connectionGrants, integrationGrants, type AppRow, type AppStatus } from "../store/schema.ts";
import { isReservedAppName, RESERVED_APP_NAME } from "../reserved.ts";

export type AppRegistration = AppRow;

/** `control` is the platform's reserved control-surface alias — never an app name. */
const notReserved = Schema.makeFilter((name: string) =>
  isReservedAppName(name)
    ? `"${RESERVED_APP_NAME}" is reserved for the platform control surface and cannot be an app name`
    : undefined
);

export const RegisterAppInput = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/), notReserved),
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  oidcClientId: Schema.optional(Schema.String),
  /** Preview lineage (docs/previews-and-acl.md) — set by the scaffold on preview apps. */
  previewOf: Schema.optional(Schema.String),
  previewPr: Schema.optional(Schema.String),
});
export type RegisterAppInput = typeof RegisterAppInput.Type;

type ProvisionedIdentity = {
  readonly m2mClientId: string;
  readonly oidcRegistrationToken: string;
};

export class Registry extends Context.Service<Registry, {
  readonly register: (input: RegisterAppInput, identity?: ProvisionedIdentity) => Effect.Effect<AppRegistration>;
  readonly appForM2mClient: (clientId: string) => Effect.Effect<string | undefined>;
  readonly clearM2mClient: (name: string, clientId: string) => Effect.Effect<void>;
  readonly oidcRegistrationToken: (name: string) => Effect.Effect<string | undefined>;
  readonly list: () => Effect.Effect<ReadonlyArray<AppRegistration>>;
  readonly get: (name: string) => Effect.Effect<Option.Option<AppRegistration>>;
  readonly remove: (name: string) => Effect.Effect<void>;
  readonly markUp: (name: string, seenAt: string) => Effect.Effect<void>;
  readonly markDown: (name: string, error: string) => Effect.Effect<void>;
  readonly setStatus: (name: string, status: AppStatus) => Effect.Effect<void>;
}>()("@vibevarium/control-plane/registry/Registry") {
  static readonly layer = Layer.effect(Registry)(Effect.gen(function*() {
    const { db } = yield* Database;

    const register = Effect.fnUntraced(function*(input: RegisterAppInput, identity?: ProvisionedIdentity) {
      return yield* Effect.promise(() => db.transaction(async (tx) => {
        if (identity !== undefined) {
          const [app] = await tx.insert(apps).values({ ...input, m2mClientId: identity.m2mClientId }).returning();
          await tx.insert(appOidcRegistrations).values({
            app: input.name,
            accessToken: identity.oidcRegistrationToken,
          });
          return app;
        }
        const [app] = await tx.insert(apps).values(input).onConflictDoUpdate({
          target: apps.name,
          set: {
            url: input.url,
            oidcClientId: input.oidcClientId,
            previewOf: input.previewOf ?? null,
            previewPr: input.previewPr ?? null,
          },
        }).returning();
        return app;
      }));
    });

    const appForM2mClient = (clientId: string) =>
      Effect.promise(async () => {
        const [row] = await db.select({ name: apps.name }).from(apps).where(eq(apps.m2mClientId, clientId)).limit(1);
        return row?.name;
      });

    const clearM2mClient = (name: string, clientId: string) =>
      Effect.promise(() => db.update(apps).set({ m2mClientId: null })
        .where(and(eq(apps.name, name), eq(apps.m2mClientId, clientId)))).pipe(Effect.asVoid);

    const oidcRegistrationToken = (name: string) =>
      Effect.promise(async () => {
        const [row] = await db.select().from(appOidcRegistrations).where(eq(appOidcRegistrations.app, name)).limit(1);
        return row?.accessToken;
      });

    const list = Effect.fnUntraced(function*() {
      return yield* Effect.promise(() => db.select().from(apps).orderBy(asc(apps.name)));
    });

    const get = Effect.fnUntraced(function*(name: string) {
      const rows = yield* Effect.promise(() => db.select().from(apps).where(eq(apps.name, name)).limit(1));
      return Option.fromUndefinedOr(rows[0]);
    });

    const remove = Effect.fnUntraced(function*(name: string) {
      yield* Effect.promise(() => db.transaction(async (tx) => {
        await tx.delete(integrationGrants).where(eq(integrationGrants.app, name));
        await tx.delete(connectionGrants).where(eq(connectionGrants.appId, name));
        await tx.delete(apps).where(eq(apps.name, name));
      }));
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

    return Registry.of({ register, appForM2mClient, clearM2mClient, oidcRegistrationToken, list, get, remove, markUp, markDown, setStatus });
  }));
}
