/**
 * ACL HTTP routes (docs/previews-and-acl.md Part 2).
 *
 * Gating:
 * - Read access (`GET /apps/:name/acl`) requires the caller to pass
 *   `canAccess(app, actor)` — internal apps let any platform user through,
 *   restricted apps only members (superadmins bypass).
 * - Mutations (visibility + member add/remove) require `isAdmin(app, actor)`
 *   — app admins + superadmins.
 * - `POST /platform/superadmins` is the one route gated by isSuperadmin
 *   directly: a superadmin bootstraps other superadmins.
 *
 * The caller supplies the `gated` wrapper (server.ts's GUI-session-or-bearer
 * gate) which provides `CurrentActor`; these handlers read it for the actor's
 * `sub`. When auth is disabled (local dev) there is no actor and every gate
 * is open — same posture as the rest of the control plane.
 */
import { CurrentActor } from "@terrarium/auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Acl, AclError } from "./index.ts";

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const SetVisibilityInput = Schema.Struct({
  visibility: Schema.Literals(["internal", "restricted"]),
});

const AddMemberInput = Schema.Struct({
  sub: Schema.String.check(Schema.isNonEmpty()),
  role: Schema.Literals(["admin", "member"]),
});

const GrantSuperadminInput = Schema.Struct({
  sub: Schema.String.check(Schema.isNonEmpty()),
});

const respond = <A>(effect: Effect.Effect<A, AclError>, successStatus = 200) =>
  effect.pipe(
    Effect.tapDefect((cause) => Effect.logError("acl route defect", cause)),
    Effect.matchEffect({
      onFailure: (error) => HttpServerResponse.json({ error: error.message }, { status: error.status }),
      onSuccess: (value) => HttpServerResponse.json(value, { status: successStatus }),
    }),
  );

// The gate factory's exact requirement shape is the caller's business — it
// matches server.ts's `gated` (GUI session OR bearer, providing CurrentActor).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gated = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, any>;

export const aclRoutes = (gated: Gated) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const acl = yield* Acl;

      yield* router.add("GET", "/apps/:name/acl", gated(Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const name = params.name;
        if (name === undefined || !dnsLabel.test(name)) {
          return yield* HttpServerResponse.json({ error: "Invalid app name" }, { status: 400 });
        }
        const actor = yield* Effect.serviceOption(CurrentActor);
        const sub = Option.map(actor, (a) => a.sub);
        if (Option.isSome(sub)) {
          const allowed = yield* acl.canAccess(name, sub.value);
          if (!allowed) {
            return yield* HttpServerResponse.json(
              { error: `You do not have access to ${name}` },
              { status: 403 },
            );
          }
        }
        const view = yield* acl.getAcl(name);
        const members = yield* acl.listMembers(name);
        const admin = Option.isSome(sub) ? yield* acl.isAdmin(name, sub.value) : false;
        const superadmin = Option.isSome(sub) ? yield* acl.isSuperadmin(sub.value) : false;
        const current = Option.getOrElse(view, () => ({
          app: name,
          visibility: "internal" as const,
          createdBy: null,
        }));
        return yield* HttpServerResponse.json({
          app: name,
          visibility: current.visibility,
          createdBy: current.createdBy,
          members,
          caller: { sub: Option.getOrNull(sub), isAdmin: admin, isSuperadmin: superadmin },
        });
      })));

      yield* router.add("PUT", "/apps/:name/acl/visibility", gated(Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const name = params.name;
        if (name === undefined || !dnsLabel.test(name)) {
          return yield* HttpServerResponse.json({ error: "Invalid app name" }, { status: 400 });
        }
        const actor = yield* Effect.serviceOption(CurrentActor);
        if (Option.isSome(actor)) {
          const admin = yield* acl.isAdmin(name, actor.value.sub);
          if (!admin) {
            return yield* HttpServerResponse.json(
              { error: `Only admins of ${name} can change visibility` },
              { status: 403 },
            );
          }
        }
        const request = yield* HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const decoded = yield* Schema.decodeUnknownEffect(SetVisibilityInput)(body).pipe(Effect.result);
        if (Result.isFailure(decoded)) {
          return yield* HttpServerResponse.json(
            { error: "Expected { visibility: 'internal' | 'restricted' }", details: decoded.failure.message },
            { status: 400 },
          );
        }
        return yield* respond(acl.setVisibility(name, decoded.success.visibility));
      })));

      yield* router.add("POST", "/apps/:name/acl/members", gated(Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const name = params.name;
        if (name === undefined || !dnsLabel.test(name)) {
          return yield* HttpServerResponse.json({ error: "Invalid app name" }, { status: 400 });
        }
        const actor = yield* Effect.serviceOption(CurrentActor);
        if (Option.isSome(actor)) {
          const admin = yield* acl.isAdmin(name, actor.value.sub);
          if (!admin) {
            return yield* HttpServerResponse.json(
              { error: `Only admins of ${name} can add members` },
              { status: 403 },
            );
          }
        }
        const request = yield* HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const decoded = yield* Schema.decodeUnknownEffect(AddMemberInput)(body).pipe(Effect.result);
        if (Result.isFailure(decoded)) {
          return yield* HttpServerResponse.json(
            { error: "Expected { sub, role: 'admin' | 'member' }", details: decoded.failure.message },
            { status: 400 },
          );
        }
        return yield* respond(acl.addMember(name, decoded.success.sub, decoded.success.role), 201);
      })));

      yield* router.add("DELETE", "/apps/:name/acl/members/:sub", gated(Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        const name = params.name;
        const target = params.sub;
        if (name === undefined || !dnsLabel.test(name)) {
          return yield* HttpServerResponse.json({ error: "Invalid app name" }, { status: 400 });
        }
        if (target === undefined || target === "") {
          return yield* HttpServerResponse.json({ error: "Missing member sub" }, { status: 400 });
        }
        const actor = yield* Effect.serviceOption(CurrentActor);
        if (Option.isSome(actor)) {
          const admin = yield* acl.isAdmin(name, actor.value.sub);
          if (!admin) {
            return yield* HttpServerResponse.json(
              { error: `Only admins of ${name} can remove members` },
              { status: 403 },
            );
          }
        }
        return yield* respond(Effect.as(acl.removeMember(name, target), { removed: target }));
      })));

      // Superadmin bootstrap: the one route gated by isSuperadmin directly.
      yield* router.add("POST", "/platform/superadmins", gated(Effect.gen(function*() {
        const actor = yield* Effect.serviceOption(CurrentActor);
        if (Option.isSome(actor)) {
          const superadmin = yield* acl.isSuperadmin(actor.value.sub);
          if (!superadmin) {
            return yield* HttpServerResponse.json(
              { error: "Only superadmins can grant superadmin" },
              { status: 403 },
            );
          }
        }
        const request = yield* HttpServerRequest;
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        const decoded = yield* Schema.decodeUnknownEffect(GrantSuperadminInput)(body).pipe(Effect.result);
        if (Result.isFailure(decoded)) {
          return yield* HttpServerResponse.json(
            { error: "Expected { sub }", details: decoded.failure.message },
            { status: 400 },
          );
        }
        yield* acl.grantSuperadmin(decoded.success.sub);
        return yield* HttpServerResponse.json({ granted: decoded.success.sub }, { status: 201 });
      })));
    })
  );
