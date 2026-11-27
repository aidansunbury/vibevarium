import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GuiAuth, SessionRefreshError, type AuthFlowOptions, type Session } from "./auth-flow.ts";
import type { ConnectionsConfig } from "./config/connections-schema.ts";
import { SecretsProvider } from "./integrations/secrets.ts";
import { startControlPlane } from "./server.ts";
import { Database } from "./store/database.ts";
import { sessionTransactions, sessions } from "./store/schema.ts";

const KEY = "test-gui-session-encryption-key";
const tempDb = () => mkdtempSync(join(tmpdir(), `vv-gui-auth-${randomUUID()}-`));
const options: AuthFlowOptions = {
  issuer: "https://issuer.test",
  clientId: "gui-client",
  clientSecret: "gui-secret",
  baseUrl: "https://api.vibevarium.test",
  guiOrigin: "https://platform.vibevarium.test",
  cookieDomain: ".vibevarium.test",
  resource: "https://api.vibevarium.test/mcp",
};

const secretsLayer = (key: string | null | undefined = KEY) => Layer.succeed(
  SecretsProvider,
  SecretsProvider.of({ resolve: () => Effect.succeed(Option.fromUndefinedOr(key ?? undefined)) }),
);

const runWithAuth = <A, E>(
  program: Effect.Effect<A, E, GuiAuth | Database>,
  overrides: Partial<AuthFlowOptions> = {},
) => {
  const databaseLayer = Database.pgliteLayer(tempDb());
  const authLayer = GuiAuth.layer({ ...options, ...overrides }).pipe(
    Layer.provide(databaseLayer),
    Layer.provide(secretsLayer()),
  );
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(Layer.mergeAll(databaseLayer, authLayer));
    return yield* program.pipe(
      Effect.provideService(Database, Context.get(context, Database)),
      Effect.provideService(GuiAuth, Context.get(context, GuiAuth)),
    );
  })));
};

const session = (overrides: Partial<Session> = {}): Session => {
  const now = Date.now();
  return {
    sub: "user-123",
    name: "Ada",
    accessToken: "plain-access-token",
    idToken: "plain-id-token",
    refreshToken: "plain-refresh-token",
    accessTokenExpiresAt: now + 60 * 60_000,
    sessionExpiresAt: now + 7 * 24 * 60 * 60_000,
    ...overrides,
  };
};

const mockTokenEndpoint = (
  response: () => Response | Promise<Response>,
  tokenEndpoint = "https://issuer.test/oauth/token",
) => {
  const forms: Array<URLSearchParams> = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://issuer.test/.well-known/openid-configuration") {
      return Response.json({
        authorization_endpoint: "https://issuer.test/oauth/authorize",
        token_endpoint: tokenEndpoint,
      });
    }
    if (url === tokenEndpoint) {
      const body = init?.body;
      if (typeof body !== "string" && !(body instanceof URLSearchParams)) {
        throw new Error("Expected a form-encoded token request");
      }
      forms.push(new URLSearchParams(body));
      return response();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, forms };
};

const successfulRefresh = (body: Record<string, unknown> = {}) => mockTokenEndpoint(() => Response.json({
  access_token: "rotated-access-token",
  id_token: "rotated-id-token",
  refresh_token: "rotated-refresh-token",
  expires_in: 3600,
  ...body,
}));

afterEach(() => vi.restoreAllMocks());

describe("durable GUI sessions", () => {
  it("reads a session from a newly constructed layer sharing the same database and key", async () => {
    const databaseLayer = Database.pgliteLayer(tempDb());
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const database = Context.get(yield* Layer.build(databaseLayer), Database);
      const makeAuth = () => GuiAuth.layer(options).pipe(
        Layer.provide(Layer.succeed(Database, database)),
        Layer.provide(secretsLayer()),
      );
      const first = Context.get(yield* Layer.build(makeAuth()), GuiAuth);
      const cookie = yield* first.createSession(session());
      const second = Context.get(yield* Layer.build(makeAuth()), GuiAuth);
      const restored = yield* second.getSession(cookie);
      expect(restored?.accessToken).toBe("plain-access-token");
      expect(restored?.sub).toBe("user-123");
    })));
  });

  it("stores only hashed cookie IDs and versioned encrypted credentials", async () => {
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.createSession(session());
      const rawId = cookie.split(".")[0]!;
      const rows = yield* Effect.promise(() => db.select().from(sessions));
      expect(rows).toHaveLength(1);
      const stored = JSON.stringify(rows[0]);
      for (const plaintext of [rawId, cookie, "plain-access-token", "plain-id-token", "plain-refresh-token"]) {
        expect(stored).not.toContain(plaintext);
      }
      expect(rows[0]!.accessTokenEncrypted).toMatch(/^v1:[^:]+:[^:]+:[^:]+:/);
      expect(rows[0]!.idTokenEncrypted).toMatch(/^v1:/);
      expect(rows[0]!.refreshTokenEncrypted).toMatch(/^v1:/);
    }));
  });

  it("rejects a tampered signed cookie without deleting the session", async () => {
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.createSession(session());
      const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`;
      expect(yield* auth.getSession(tampered)).toBeUndefined();
      expect(yield* auth.getSession(cookie)).toBeDefined();
      expect(yield* Effect.promise(() => db.select().from(sessions))).toHaveLength(1);
    }));
  });

  it("deletes and rejects an absolutely expired session even when its access token is valid", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.createSession(session({ sessionExpiresAt: Date.now() - 1000 }));
      expect(yield* auth.getSession(cookie)).toBeUndefined();
      expect(yield* Effect.promise(() => db.select().from(sessions))).toHaveLength(0);
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not contact discovery or refresh while the access token is valid", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const cookie = yield* auth.createSession(session());
      expect((yield* auth.getSession(cookie))?.accessToken).toBe("plain-access-token");
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a near-expiry Casdoor token and persists rotated credentials", async () => {
    const { fetchMock, forms } = successfulRefresh();
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.createSession(session({ accessTokenExpiresAt: Date.now() + 30_000 }));
      const refreshed = yield* auth.getSession(cookie);
      expect(refreshed?.accessToken).toBe("rotated-access-token");
      expect(refreshed?.idToken).toBe("rotated-id-token");
      expect(refreshed?.refreshToken).toBe("rotated-refresh-token");
      expect(refreshed?.sessionExpiresAt).toBeGreaterThan(Date.now());

      const rows = yield* Effect.promise(() => db.select().from(sessions));
      expect(JSON.stringify(rows[0])).not.toContain("rotated-access-token");
      const reread = yield* auth.getSession(cookie);
      expect(reread?.refreshToken).toBe("rotated-refresh-token");
      // The second read is outside the skew and needs no second provider call.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }));
    expect(forms).toHaveLength(1);
    expect(forms[0]!.get("grant_type")).toBe("refresh_token");
    expect(forms[0]!.get("refresh_token")).toBe("plain-refresh-token");
    expect(forms[0]!.get("client_secret")).toBe("gui-secret");
    expect(forms[0]!.get("resource")).toBe(options.resource);
    expect(forms[0]!.get("scope")).toBe("openid profile email offline_access");
  });

  it("preserves prior credentials when a WorkOS refresh omits replacement ID and refresh tokens", async () => {
    const { forms } = successfulRefresh({ id_token: undefined, refresh_token: undefined });
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const cookie = yield* auth.createSession(session({ accessTokenExpiresAt: Date.now() + 30_000 }));
      const refreshed = yield* auth.getSession(cookie);
      expect(refreshed?.accessToken).toBe("rotated-access-token");
      expect(refreshed?.idToken).toBe("plain-id-token");
      expect(refreshed?.refreshToken).toBe("plain-refresh-token");
      const reread = yield* auth.getSession(cookie);
      expect(reread?.idToken).toBe("plain-id-token");
      expect(reread?.refreshToken).toBe("plain-refresh-token");
    }), { clientSecret: "" });
    expect(forms[0]!.has("client_secret")).toBe(false);
  });

  it("deletes the session and returns unauthenticated for an invalid refresh grant", async () => {
    mockTokenEndpoint(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.createSession(session({ accessTokenExpiresAt: Date.now() - 1000 }));
      expect(yield* auth.getSession(cookie)).toBeUndefined();
      expect(yield* Effect.promise(() => db.select().from(sessions))).toHaveLength(0);
    }));
  });

  it("preserves session state and reports a temporary error after a transient refresh failure", async () => {
    mockTokenEndpoint(() => Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.createSession(session({ accessTokenExpiresAt: Date.now() - 1000 }));
      const before = (yield* Effect.promise(() => db.select().from(sessions)))[0]!;
      const result = yield* Effect.result(auth.getSession(cookie));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SessionRefreshError);
      const after = (yield* Effect.promise(() => db.select().from(sessions)))[0]!;
      expect(after).toEqual(before);
    }));
  });

  it("uses a still-valid access token when an early refresh is temporarily unavailable", async () => {
    mockTokenEndpoint(() => Response.json({}, { status: 503 }));
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const cookie = yield* auth.createSession(session({ accessTokenExpiresAt: Date.now() + 30_000 }));
      expect((yield* auth.getSession(cookie))?.accessToken).toBe("plain-access-token");
    }));
  });

  it("single-flights concurrent refreshes for one session", async () => {
    const { forms } = mockTokenEndpoint(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return Response.json({ access_token: "single-flight-access", refresh_token: "single-flight-refresh", expires_in: 3600 });
    });
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const cookie = yield* auth.createSession(session({ accessTokenExpiresAt: Date.now() + 1000 }));
      const resolved = yield* Effect.all([auth.getSession(cookie), auth.getSession(cookie), auth.getSession(cookie)], {
        concurrency: "unbounded",
      });
      expect(resolved.every((value) => value?.accessToken === "single-flight-access")).toBe(true);
    }));
    expect(forms).toHaveLength(1);
  });

  it("row-locks independent layers so a losing invalid_grant cannot precede the winning commit", async () => {
    const { forms } = mockTokenEndpoint(async () => {
      // Keep the winning transaction open long enough for the second layer to
      // queue on its row lock. Only one task may present the old refresh token.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ access_token: "winning-access", refresh_token: "winning-refresh", expires_in: 3600 });
    });
    const databaseLayer = Database.pgliteLayer(tempDb());
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const database = Context.get(yield* Layer.build(databaseLayer), Database);
      const makeAuth = () => GuiAuth.layer(options).pipe(
        Layer.provide(Layer.succeed(Database, database)),
        Layer.provide(secretsLayer()),
      );
      const first = Context.get(yield* Layer.build(makeAuth()), GuiAuth);
      const second = Context.get(yield* Layer.build(makeAuth()), GuiAuth);
      const cookie = yield* first.createSession(session({ accessTokenExpiresAt: Date.now() - 1000 }));
      const resolved = yield* Effect.all([first.getSession(cookie), second.getSession(cookie)], { concurrency: "unbounded" });
      expect(resolved).toHaveLength(2);
      expect(resolved.every((value) => value?.accessToken === "winning-access")).toBe(true);
      expect(yield* Effect.promise(() => database.db.select().from(sessions))).toHaveLength(1);
    })));
    expect(forms).toHaveLength(1);
  });

  it("deletes the durable row on explicit logout", async () => {
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.createSession(session());
      yield* auth.destroySession(cookie);
      expect(yield* auth.getSession(cookie)).toBeUndefined();
      expect(yield* Effect.promise(() => db.select().from(sessions))).toHaveLength(0);
    }));
  });
});

describe("durable OIDC login transactions", () => {
  it("survives layer reconstruction, stores no plaintext secrets, and is one-time", async () => {
    const databaseLayer = Database.pgliteLayer(tempDb());
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const database = Context.get(yield* Layer.build(databaseLayer), Database);
      const makeAuth = () => GuiAuth.layer(options).pipe(
        Layer.provide(Layer.succeed(Database, database)),
        Layer.provide(secretsLayer()),
      );
      const first = Context.get(yield* Layer.build(makeAuth()), GuiAuth);
      const cookie = yield* first.rememberPending({ verifier: "plain-pkce-verifier", state: "plain-oauth-state", returnTo: "/grants/consent?grant=123" });
      const rawId = cookie.split(".")[0]!;
      const rows = yield* Effect.promise(() => database.db.select().from(sessionTransactions));
      const stored = JSON.stringify(rows[0]);
      for (const plaintext of [rawId, cookie, "plain-pkce-verifier", "plain-oauth-state"]) {
        expect(stored).not.toContain(plaintext);
      }
      expect(rows[0]!.pkceVerifierEncrypted).toMatch(/^v1:/);
      expect(rows[0]!.stateHash).toBe(createHash("sha256").update("plain-oauth-state").digest("base64url"));

      const second = Context.get(yield* Layer.build(makeAuth()), GuiAuth);
      const consumed = yield* Effect.all([second.takePending(cookie), second.takePending(cookie)], { concurrency: "unbounded" });
      expect(consumed.filter((value) => value !== undefined)).toHaveLength(1);
      const pending = consumed.find((value) => value !== undefined);
      expect(pending?.verifier).toBe("plain-pkce-verifier");
      expect(pending?.returnTo).toBe("/grants/consent?grant=123");
      expect(yield* second.takePending(cookie)).toBeUndefined();
    })));
  });

  it("consumes and rejects an expired transaction", async () => {
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const { db } = yield* Database;
      const cookie = yield* auth.rememberPending({ verifier: "verifier", state: "state" });
      yield* Effect.promise(() => db.update(sessionTransactions).set({ expiresAt: new Date(0).toISOString() }));
      expect(yield* auth.takePending(cookie)).toBeUndefined();
      expect(yield* Effect.promise(() => db.select().from(sessionTransactions))).toHaveLength(0);
    }));
  });

  it("rejects a tampered pending cookie", async () => {
    await runWithAuth(Effect.gen(function*() {
      const auth = yield* GuiAuth;
      const cookie = yield* auth.rememberPending({ verifier: "verifier", state: "state" });
      expect(yield* auth.takePending(`${cookie}x`)).toBeUndefined();
      expect(yield* auth.takePending(cookie)).toBeDefined();
    }));
  });
});

describe("GUI auth boot requirements", () => {
  it("fails clearly instead of falling back to memory when the encryption key is absent", async () => {
    const databaseLayer = Database.pgliteLayer(tempDb());
    const layer = GuiAuth.layer(options).pipe(
      Layer.provide(databaseLayer),
      Layer.provide(secretsLayer(null)),
    );
    await expect(Effect.runPromise(Effect.scoped(Layer.build(layer)))).rejects.toThrow("SESSION_ENCRYPTION_KEY");
  });
});

const EMPTY_CONNECTIONS_CONFIG = {
  secrets: {},
  oauthProviders: {},
  proxiedSecrets: {},
  webhooks: {},
  webhookDeliverySecrets: {},
} satisfies ConnectionsConfig;

const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
};

const closeServer = async (server: Server) => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
};

const idToken = () => [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "user-123", name: "Ada" })).toString("base64url"),
  "test-signature",
].join(".");

const makeIssuer = async () => {
  const tokenRequests: Array<URLSearchParams> = [];
  let initialExpiresIn = 3600;
  let refreshStatus = 200;
  let refreshBody: Record<string, unknown> = {
    access_token: "refreshed-access",
    refresh_token: "refreshed-refresh",
    expires_in: 3600,
  };
  let issuerUrl = "";
  const server = createServer(async (request, response) => {
    if (request.url === "/.well-known/openid-configuration") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
      }));
      return;
    }
    if (request.url === "/token" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const form = new URLSearchParams(text);
      tokenRequests.push(form);
      response.writeHead(form.get("grant_type") === "refresh_token" ? refreshStatus : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(form.get("grant_type") === "refresh_token" ? refreshBody : {
        access_token: "initial-access",
        id_token: idToken(),
        refresh_token: "initial-refresh",
        expires_in: initialExpiresIn,
      }));
      return;
    }
    response.writeHead(404).end();
  });
  issuerUrl = (await listen(server)).url;
  return {
    url: issuerUrl,
    tokenRequests,
    setInitialExpiresIn: (value: number) => { initialExpiresIn = value; },
    setRefreshResponse: (status: number, body: Record<string, unknown>) => {
      refreshStatus = status;
      refreshBody = body;
    },
    close: () => closeServer(server),
  };
};

const startGui = async (issuer: string, databasePath: string, port: number) => {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const controlPlane = await Effect.runPromise(Effect.provideService(startControlPlane({
      port,
      host: "127.0.0.1",
      baseUrl,
      databasePath,
      discoveryIntervalMs: 60_000,
      connectionsConfig: EMPTY_CONNECTIONS_CONFIG,
      guiAuth: {
        issuer,
        clientId: "gui-client",
        clientSecret: "gui-secret",
        baseUrl,
        guiOrigin: "https://platform.vibevarium.test",
        cookieDomain: ".vibevarium.test",
        resource: "https://api.vibevarium.test/mcp",
        sessionTtlMs: 2 * 60 * 60_000,
      },
    }), Scope.Scope, scope));
    return {
      url: controlPlane.url,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
};

const cookiePair = (response: Response) => response.headers.get("set-cookie")!.split(";", 1)[0]!;

const beginLogin = async (url: string, returnTo = "/") => {
  const response = await fetch(`${url}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
  expect(response.status).toBe(302);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("Domain=.vibevarium.test");
  expect(setCookie).toContain("Max-Age=600");
  const authorize = new URL(response.headers.get("location")!);
  return { pendingCookie: cookiePair(response), state: authorize.searchParams.get("state")! };
};

describe("OIDC HTTP flow", () => {
  let previousKey: string | undefined;
  beforeAll(() => {
    previousKey = process.env.SESSION_ENCRYPTION_KEY;
    process.env.SESSION_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.SESSION_ENCRYPTION_KEY;
    else process.env.SESSION_ENCRYPTION_KEY = previousKey;
  });

  it("completes a pre-deploy login and preserves the session across subsequent restarts and logout", async () => {
    const issuer = await makeIssuer();
    const portServer = createServer();
    const { port } = await listen(portServer);
    await closeServer(portServer);
    const databasePath = tempDb();
    let gui: Awaited<ReturnType<typeof startGui>> | undefined;
    try {
      gui = await startGui(issuer.url, databasePath, port);
      const login = await beginLogin(gui.url, "/grants/consent?grant=grant-123");
      await gui.close();

      // The callback hits a new process/layer with only the durable DB and key.
      gui = await startGui(issuer.url, databasePath, port);
      const callback = await fetch(`${gui.url}/auth/callback?code=auth-code&state=${encodeURIComponent(login.state)}`, {
        headers: { cookie: login.pendingCookie },
        redirect: "manual",
      });
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/grants/consent?grant=grant-123");
      const sessionSetCookie = callback.headers.get("set-cookie")!;
      expect(sessionSetCookie).toContain("HttpOnly");
      expect(sessionSetCookie).toContain("SameSite=Lax");
      expect(sessionSetCookie).toContain("Secure");
      expect(sessionSetCookie).toContain("Domain=.vibevarium.test");
      expect(sessionSetCookie).toContain("Max-Age=7200");
      const sessionCookie = cookiePair(callback);
      await gui.close();

      gui = await startGui(issuer.url, databasePath, port);
      const me = await fetch(`${gui.url}/auth/me`, { headers: { cookie: sessionCookie } });
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ actor: { sub: "user-123", name: "Ada" }, auth: "on" });

      const configCheck = await fetch(`${gui.url}/config-check`);
      const configText = await configCheck.text();
      expect(configText).not.toContain(KEY);
      expect(JSON.parse(configText).config.SESSION_ENCRYPTION_KEY).toMatchObject({ set: true });

      const logout = await fetch(`${gui.url}/auth/logout`, {
        method: "POST",
        headers: { cookie: sessionCookie },
        redirect: "manual",
      });
      expect(logout.status).toBe(302);
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
      const afterLogout = await fetch(`${gui.url}/auth/me`, { headers: { cookie: sessionCookie } });
      expect(await afterLogout.json()).toEqual({ actor: null, auth: "on" });
      expect(issuer.tokenRequests).toHaveLength(1);
      expect(issuer.tokenRequests[0]!.get("code_verifier")).toBeTruthy();
    } finally {
      if (gui !== undefined) await gui.close();
      await issuer.close();
    }
  }, 30_000);

  it("rejects state mismatch and consumes the transaction so replay fails", async () => {
    const issuer = await makeIssuer();
    const portServer = createServer();
    const { port } = await listen(portServer);
    await closeServer(portServer);
    const gui = await startGui(issuer.url, tempDb(), port);
    try {
      const login = await beginLogin(gui.url);
      const mismatch = await fetch(`${gui.url}/auth/callback?code=auth-code&state=wrong-state`, {
        headers: { cookie: login.pendingCookie },
        redirect: "manual",
      });
      expect(mismatch.status).toBe(401);
      expect(await mismatch.json()).toEqual({ error: "State mismatch" });

      const replay = await fetch(`${gui.url}/auth/callback?code=auth-code&state=${encodeURIComponent(login.state)}`, {
        headers: { cookie: login.pendingCookie },
        redirect: "manual",
      });
      expect(replay.status).toBe(400);
      expect(await replay.json()).toEqual({ error: "Unknown or expired login transaction" });
      expect(issuer.tokenRequests).toHaveLength(0);
    } finally {
      await gui.close();
      await issuer.close();
    }
  }, 30_000);

  it("returns 503 without login redirection on transient refresh failure, then recovers", async () => {
    const issuer = await makeIssuer();
    issuer.setInitialExpiresIn(0);
    const portServer = createServer();
    const { port } = await listen(portServer);
    await closeServer(portServer);
    const gui = await startGui(issuer.url, tempDb(), port);
    try {
      const login = await beginLogin(gui.url);
      const callback = await fetch(`${gui.url}/auth/callback?code=auth-code&state=${encodeURIComponent(login.state)}`, {
        headers: { cookie: login.pendingCookie },
        redirect: "manual",
      });
      const sessionCookie = cookiePair(callback);
      issuer.setRefreshResponse(503, { error: "temporarily_unavailable" });
      const unavailable = await fetch(`${gui.url}/auth/me`, { headers: { cookie: sessionCookie } });
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("retry-after")).toBe("5");
      expect(await unavailable.json()).toMatchObject({ error: "auth_service_unavailable" });

      const connections = await fetch(`${gui.url}/connections`, { headers: { cookie: sessionCookie } });
      expect(connections.status).toBe(503);
      expect(await connections.json()).toMatchObject({ error: "auth_service_unavailable" });
      const consent = await fetch(`${gui.url}/grants/consent?grant=grant-123`, { headers: { cookie: sessionCookie } });
      expect(consent.status).toBe(503);
      expect(await consent.json()).toMatchObject({ error: "auth_service_unavailable" });

      issuer.setRefreshResponse(200, { access_token: "recovered-access", refresh_token: "recovered-refresh", expires_in: 3600 });
      const recovered = await fetch(`${gui.url}/auth/me`, { headers: { cookie: sessionCookie } });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ actor: { sub: "user-123", name: "Ada" }, auth: "on" });
      expect(issuer.tokenRequests.map((form) => form.get("grant_type"))).toEqual([
        "authorization_code",
        "refresh_token",
        "refresh_token",
        "refresh_token",
        "refresh_token",
      ]);
    } finally {
      await gui.close();
      await issuer.close();
    }
  }, 30_000);
});
