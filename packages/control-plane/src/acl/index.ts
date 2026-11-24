/**
 * App ACLs (docs/previews-and-acl.md Part 2).
 *
 * The control plane OWNS the ACL policy as plain rows (Tier 1/2 facts keyed by
 * `sub`). Enforcement at request time belongs to the app/router/gateway — each
 * block authorizes itself. This service is the read/write surface for that
 * policy plus the control-plane's own gates (GUI/API mutations, app detail).
 *
 * Model:
 * - `app_acl` — one row per app: visibility ('internal' | 'restricted') + the
 *   immutable creator seed. `internal` = any authenticated platform user
 *   passes; `restricted` = member-list check.
 * - `app_acl_members` — (app, user_sub, role, source) rows. `source` makes the
 *   model sync-ready: a future Okta/SCIM sync writes source='external' rows
 *   and never fights manual 'local' grants.
 * - `platform_roles` — platform-wide roles. 'superadmin' bypasses every ACL
 *   check and gates sensitive platform ops.
 *
 * Superadmin has two sources, either suffices:
 * - the `TERRARIUM_SUPERADMINS` env var (comma-separated subs), and
 * - the `platform_roles` table (runtime grants).
 */
import { and, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Database } from "../store/database.ts";
import {
  appAcl,
  appAclMembers,
  platformRoles,
  type AclRole,
  type AclSource,
  type AppVisibility,
} from "../store/schema.ts";

export class AclError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AclError";
    this.status = status;
  }
}

export interface AclView {
  readonly app: string;
  readonly visibility: AppVisibility;
  readonly createdBy: string | null;
}

export interface MemberView {
  readonly app: string;
  readonly userSub: string;
  readonly role: AclRole;
  readonly source: AclSource;
  readonly createdAt: string;
}

export class Acl extends Context.Service<Acl, {
  /** The app's ACL row, if one exists (legacy apps may not have been seeded). */
  readonly getAcl: (app: string) => Effect.Effect<Option.Option<AclView>>;
  /** Create the ACL row if missing, then set visibility. */
  readonly setVisibility: (app: string, visibility: AppVisibility) => Effect.Effect<AclView, AclError>;
  readonly listMembers: (app: string) => Effect.Effect<ReadonlyArray<MemberView>>;
  readonly addMember: (app: string, sub: string, role: AclRole) => Effect.Effect<MemberView, AclError>;
  /** Only 'local' rows can be removed — 'external' rows belong to the directory sync. */
  readonly removeMember: (app: string, sub: string) => Effect.Effect<void, AclError>;
  /** Superadmin OR internal-visibility OR a member row (any role). */
  readonly canAccess: (app: string, userSub: string) => Effect.Effect<boolean>;
  /** Superadmin OR an admin member row (the creator seed is an admin row too). */
  readonly isAdmin: (app: string, userSub: string) => Effect.Effect<boolean>;
  /** Env seed (TERRARIUM_SUPERADMINS) OR a platform_roles row. */
  readonly isSuperadmin: (userSub: string) => Effect.Effect<boolean>;
  /** Grant a platform superadmin role (superadmin-gated at the route). */
  readonly grantSuperadmin: (sub: string) => Effect.Effect<void>;
  /**
   * Seed the creator as admin at provision time. Idempotent: creates the ACL
   * row when missing and upserts the creator's admin member row.
   */
  readonly seedCreator: (app: string, userSub: string) => Effect.Effect<void>;
}>()("@vibevarium/control-plane/acl/Acl") {
  static readonly layer = (options: { readonly superadmins?: ReadonlyArray<string> | undefined } = {}) =>
    Layer.effect(Acl)(Effect.gen(function*() {
      const { db } = yield* Database;
      const envSuperadmins = new Set(options.superadmins ?? []);

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      const isSuperadmin = Effect.fnUntraced(function*(userSub: string) {
        if (envSuperadmins.has(userSub)) return true;
        const rows = yield* Effect.promise(() =>
          db.select().from(platformRoles).where(eq(platformRoles.userSub, userSub)).limit(1)
        );
        return rows[0]?.role === "superadmin";
      });

      const getAcl = Effect.fnUntraced(function*(app: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(appAcl).where(eq(appAcl.app, app)).limit(1)
        );
        const row = rows[0];
        return Option.fromUndefinedOr(
          row === undefined
            ? undefined
            : { app: row.app, visibility: row.visibility, createdBy: row.createdBy },
        );
      });

      /** Upsert the ACL row (legacy apps get one on first mutation). */
      const ensureAcl = Effect.fnUntraced(function*(app: string) {
        const updatedAt = yield* nowIso;
        yield* Effect.promise(() =>
          db.insert(appAcl).values({ app, updatedAt }).onConflictDoNothing({ target: appAcl.app })
        );
      });

      const setVisibility = Effect.fnUntraced(function*(app: string, visibility: AppVisibility) {
        yield* ensureAcl(app);
        const updatedAt = yield* nowIso;
        const rows = yield* Effect.promise(() =>
          db.update(appAcl).set({ visibility, updatedAt }).where(eq(appAcl.app, app)).returning()
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail(new AclError(404, `App ${app} has no ACL row`));
        }
        return { app: row.app, visibility: row.visibility, createdBy: row.createdBy };
      });

      const listMembers = Effect.fnUntraced(function*(app: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(appAclMembers).where(eq(appAclMembers.app, app))
        );
        return rows.map((row) => ({
          app: row.app,
          userSub: row.userSub,
          role: row.role,
          source: row.source,
          createdAt: row.createdAt,
        }));
      });

      const addMember = Effect.fnUntraced(function*(app: string, sub: string, role: AclRole) {
        yield* ensureAcl(app);
        const rows = yield* Effect.promise(() =>
          db.insert(appAclMembers).values({ app, userSub: sub, role, source: "local" })
            .onConflictDoUpdate({
              target: [appAclMembers.app, appAclMembers.userSub],
              set: { role, source: "local" },
            })
            .returning()
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail(new AclError(500, `Failed to add member ${sub} to ${app}`));
        }
        return { app: row.app, userSub: row.userSub, role: row.role, source: row.source, createdAt: row.createdAt };
      });

      const removeMember = Effect.fnUntraced(function*(app: string, sub: string) {
        const existing = yield* Effect.promise(() =>
          db.select().from(appAclMembers)
            .where(and(eq(appAclMembers.app, app), eq(appAclMembers.userSub, sub)))
            .limit(1)
        );
        const row = existing[0];
        if (row === undefined) {
          return yield* Effect.fail(new AclError(404, `${sub} is not a member of ${app}`));
        }
        if (row.source === "external") {
          return yield* Effect.fail(new AclError(
            409,
            `${sub} was synced from an external directory — remove the grant at the source`,
          ));
        }
        yield* Effect.promise(() =>
          db.delete(appAclMembers)
            .where(and(eq(appAclMembers.app, app), eq(appAclMembers.userSub, sub)))
        );
      });

      const canAccess = Effect.fnUntraced(function*(app: string, userSub: string) {
        if (yield* isSuperadmin(userSub)) return true;
        const acl = yield* getAcl(app);
        // No ACL row (legacy app) → internal default: any platform user passes.
        if (Option.isNone(acl)) return true;
        if (acl.value.visibility === "internal") return true;
        const rows = yield* Effect.promise(() =>
          db.select().from(appAclMembers)
            .where(and(eq(appAclMembers.app, app), eq(appAclMembers.userSub, userSub)))
            .limit(1)
        );
        return rows[0] !== undefined;
      });

      const isAdmin = Effect.fnUntraced(function*(app: string, userSub: string) {
        if (yield* isSuperadmin(userSub)) return true;
        const rows = yield* Effect.promise(() =>
          db.select().from(appAclMembers)
            .where(and(eq(appAclMembers.app, app), eq(appAclMembers.userSub, userSub)))
            .limit(1)
        );
        return rows[0]?.role === "admin";
      });

      const grantSuperadmin = Effect.fnUntraced(function*(sub: string) {
        yield* Effect.promise(() =>
          db.insert(platformRoles).values({ userSub: sub, role: "superadmin" })
            .onConflictDoNothing({ target: platformRoles.userSub })
        );
      });

      const seedCreator = Effect.fnUntraced(function*(app: string, userSub: string) {
        const updatedAt = yield* nowIso;
        yield* Effect.promise(() =>
          db.insert(appAcl).values({ app, createdBy: userSub, updatedAt })
            .onConflictDoNothing({ target: appAcl.app })
        );
        yield* Effect.promise(() =>
          db.insert(appAclMembers).values({ app, userSub, role: "admin", source: "local" })
            .onConflictDoNothing({ target: [appAclMembers.app, appAclMembers.userSub] })
        );
      });

      return Acl.of({
        getAcl,
        setVisibility,
        listMembers,
        addMember,
        removeMember,
        canAccess,
        isAdmin,
        isSuperadmin,
        grantSuperadmin,
        seedCreator,
      });
    }));
}
