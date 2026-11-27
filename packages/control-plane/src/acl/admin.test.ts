import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevIssuer } from "@vibevarium/dev-issuer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vitest";
import { Acl } from "./index.ts";
import { startControlPlane } from "../server.ts";
import { Database } from "../store/database.ts";
import { platformUsers } from "../store/schema.ts";

const tempDb = () => mkdtempSync(join(tmpdir(), `vv-admin-${randomUUID()}-`));

const savedSuperadmins = process.env.TERRARIUM_SUPERADMINS;
afterEach(() => {
  if (savedSuperadmins === undefined) delete process.env.TERRARIUM_SUPERADMINS;
  else process.env.TERRARIUM_SUPERADMINS = savedSuperadmins;
});

describe("admin user listing and superadmin promotion", () => {
  it("lists users from platform_users, platform_roles, and env superadmins", async () => {
    const databaseLayer = Database.pgliteLayer(tempDb());
    const aclLayer = Acl.layer({ superadmins: ["env-admin"] }).pipe(Layer.provide(databaseLayer));

    const users = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const ctx = yield* Layer.build(Layer.mergeAll(databaseLayer, aclLayer));
      const { db } = Context.get(ctx, Database);
      const acl = Context.get(ctx, Acl);

      yield* Effect.promise(() =>
        db.insert(platformUsers).values([
          {
            sub: "user-alice",
            name: "Alice",
            email: "alice@example.com",
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-02T00:00:00.000Z",
          },
          {
            sub: "user-bob",
            name: "Bob",
            email: "bob@example.com",
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-03T00:00:00.000Z",
          },
        ])
      );
      yield* acl.grantSuperadmin("user-alice");

      return yield* acl.listUsers();
    })));

    expect(users).toHaveLength(3);
    const bySub = new Map(users.map((u) => [u.sub, u]));
    expect(bySub.get("env-admin")).toMatchObject({
      sub: "env-admin",
      isSuperadmin: true,
      superadminSource: "env",
    });
    expect(bySub.get("user-alice")).toMatchObject({
      sub: "user-alice",
      name: "Alice",
      email: "alice@example.com",
      isSuperadmin: true,
      superadminSource: "db",
    });
    expect(bySub.get("user-bob")).toMatchObject({
      sub: "user-bob",
      name: "Bob",
      email: "bob@example.com",
      isSuperadmin: false,
      superadminSource: null,
    });
  });

  it("gates GET /platform/users and POST /platform/superadmins to superadmins and allows promotion", async () => {
    const issuer = await startDevIssuer({
      port: 0,
      audiences: ["https://api.vibevarium.test/mcp"],
    });
    const mintToken = async (sub: string, name: string) => {
      const url = new URL("/dev/token", issuer.issuer);
      url.searchParams.set("sub", sub);
      url.searchParams.set("name", name);
      url.searchParams.set("aud", "https://api.vibevarium.test/mcp");
      const res = await fetch(url);
      const body = await res.json() as { access_token: string };
      return body.access_token;
    };

    process.env.TERRARIUM_SUPERADMINS = "super-1";
    const scope = Effect.runSync(Scope.make());
    try {
      const cp = await Effect.runPromise(
        startControlPlane({
          port: 0,
          databasePath: tempDb(),
          discoveryIntervalMs: 0,
          oidc: { issuer: issuer.issuer, audience: "https://api.vibevarium.test/mcp" },
        }).pipe(Scope.provide(scope)),
      );

      const superToken = await mintToken("super-1", "Super One");
      const memberToken = await mintToken("member-1", "Member One");

      // Non-superadmin cannot list users or promote anyone.
      const forbiddenList = await fetch(`${cp.url}/platform/users`, {
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(forbiddenList.status).toBe(403);

      const forbiddenPromote = await fetch(`${cp.url}/platform/superadmins`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sub: "member-1" }),
      });
      expect(forbiddenPromote.status).toBe(403);

      // Superadmin can list users.
      const initialList = await fetch(`${cp.url}/platform/users`, {
        headers: { authorization: `Bearer ${superToken}` },
      });
      expect(initialList.status).toBe(200);
      const initialBody = await initialList.json() as { users: Array<{ sub: string; isSuperadmin: boolean }> };
      expect(initialBody.users.some((u) => u.sub === "super-1" && u.isSuperadmin)).toBe(true);

      // Superadmin promotes member-1.
      const promote = await fetch(`${cp.url}/platform/superadmins`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${superToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sub: "member-1" }),
      });
      expect(promote.status).toBe(201);

      // Promoted member-1 can now list users and sees themselves as superadmin.
      const promotedList = await fetch(`${cp.url}/platform/users`, {
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(promotedList.status).toBe(200);
      const promotedBody = await promotedList.json() as {
        users: Array<{ sub: string; isSuperadmin: boolean; superadminSource: string | null }>;
      };
      expect(promotedBody.users.find((u) => u.sub === "member-1")).toMatchObject({
        sub: "member-1",
        isSuperadmin: true,
        superadminSource: "db",
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never));
      await issuer.close();
    }
  }, 30_000);
});
