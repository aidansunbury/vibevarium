/**
 * Integration proxy proof (docs/connections.md, proxy model).
 *
 * Boots: dev OIDC issuer + a tiny fake "snowflake" API + the control plane
 * (PGlite, auth on). Registers the fake as an integration whose token comes
 * from an env var, grants the demo app, calls through the proxy (app-id +
 * shared secret, the pre-M2M placeholder), sees the real token arrive at the
 * fake API, checks the audit row, revokes the grant → 403 grant_required.
 * Also exercises the user-token path through the proxy.
 */
import { startDevIssuer } from "@vibevarium/dev-issuer";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { controlPlaneServer } from "../src/server.ts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

const CONTROL_AUDIENCE = "control.vibevarium.local";
const APP_SECRET = "demo-app-shared-secret";

const report: Record<string, unknown> = {};

/** The fake "snowflake" API: echoes the auth header it received. */
const startFakeSnowflake = async () => {
  const requests: Array<{ path: string; authorization: string | undefined; body: string }> = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        path: request.url ?? "/",
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        path: request.url,
        authorization: request.headers.authorization ?? null,
        echoedBody: body === "" ? null : JSON.parse(body),
      }));
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const mintToken = async (issuer: string, audience: string, sub = "user-ada") => {
  const url = new URL("/dev/token", issuer);
  url.searchParams.set("sub", sub);
  url.searchParams.set("name", "Ada Lovelace");
  url.searchParams.set("aud", audience);
  const response = await fetch(url);
  const body = await response.json() as { access_token?: string };
  assert.ok(response.ok && body.access_token, `mint failed: ${JSON.stringify(body)}`);
  return body.access_token;
};

const issuer = await startDevIssuer({ audiences: [CONTROL_AUDIENCE] });
const snowflake = await startFakeSnowflake();

// The v1 secrets backend: env vars. The manifest row only names the env var.
process.env.INTEGRATION_SNOWFLAKE_TOKEN = "snowflake-real-token-abc123";

const scope = await Effect.runPromise(Scope.make());
const context = await Effect.runPromise(
  Layer.build(controlPlaneServer({
    port: 0,
    discoveryIntervalMs: 0,
    oidc: { issuer: issuer.issuer, audience: CONTROL_AUDIENCE },
    appSecrets: { "metrics-dashboard": APP_SECRET },
  })).pipe(Effect.provideService(Scope.Scope, scope)),
);
const server = Context.get(context, HttpServer.HttpServer);
const cp = HttpServer.formatAddress(server.address).replace(/\/$/, "");

const adminToken = await mintToken(issuer.issuer, CONTROL_AUDIENCE);
const admin = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  },
});

const json = async (response: Response) => ({ status: response.status, body: await response.json() as unknown });

// 1. Auth gate: admin routes reject anonymous callers.
report.anonymousAdminRejected = await json(await fetch(`${cp}/integrations`));

// 2. Register the fake snowflake integration (token by env var reference only).
report.registerIntegration = await json(await fetch(`${cp}/integrations`, admin({
  method: "POST",
  body: JSON.stringify({
    name: "snowflake",
    baseUrl: snowflake.url,
    tokenEnv: "INTEGRATION_SNOWFLAKE_TOKEN",
    timeoutMs: 5000,
  }),
})));

// 3. App call WITHOUT a grant → 403 grant_required.
const appHeaders = {
  "x-vibevarium-app": "metrics-dashboard",
  "x-vibevarium-app-secret": APP_SECRET,
  "content-type": "application/json",
};
report.callBeforeGrant = await json(await fetch(`${cp}/proxy/snowflake/v1/query`, {
  method: "POST",
  headers: appHeaders,
  body: JSON.stringify({ sql: "select 1" }),
}));

// 4. Bad app secret → 401.
report.callBadSecret = await json(await fetch(`${cp}/proxy/snowflake/v1/query`, {
  method: "POST",
  headers: { ...appHeaders, "x-vibevarium-app-secret": "wrong" },
  body: JSON.stringify({ sql: "select 1" }),
}));

// 5. Grant the demo app, then call again → the real token reaches the fake API.
report.grant = await json(await fetch(`${cp}/integrations/snowflake/grants`, admin({
  method: "POST",
  body: JSON.stringify({ app: "metrics-dashboard" }),
})));

report.callThroughProxy = await json(await fetch(`${cp}/proxy/snowflake/v1/query`, {
  method: "POST",
  headers: appHeaders,
  body: JSON.stringify({ sql: "select 1" }),
}));
report.tokenSeenByFakeApi = snowflake.requests.at(-1);

// 6. User-context proxying: a user bearer + on-behalf-of-app header.
report.callAsUser = await json(await fetch(`${cp}/proxy/snowflake/v1/query`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${await mintToken(issuer.issuer, CONTROL_AUDIENCE)}`,
    "x-vibevarium-on-behalf-of-app": "metrics-dashboard",
    "content-type": "application/json",
  },
  body: JSON.stringify({ sql: "select 2" }),
}));

// 7. Audit rows for every call above.
report.audit = await json(await fetch(`${cp}/integrations/snowflake/audit`, admin()));

// 8. Revoke → 403 grant_required on the very next call.
report.revoke = await json(await fetch(`${cp}/integrations/snowflake/grants/metrics-dashboard`, admin({ method: "DELETE" })));
report.callAfterRevoke = await json(await fetch(`${cp}/proxy/snowflake/v1/query`, {
  method: "POST",
  headers: appHeaders,
  body: JSON.stringify({ sql: "select 3" }),
}));

// ---- Assertions ----
assert.equal((report.anonymousAdminRejected as { status: number }).status, 401);
assert.equal((report.registerIntegration as { status: number }).status, 201);
assert.deepEqual(report.callBeforeGrant, {
  status: 403,
  body: {
    error: "grant_required",
    error_description: "App metrics-dashboard has no grant for integration snowflake",
    app: "metrics-dashboard",
    integration: "snowflake",
  },
});
assert.equal((report.callBadSecret as { status: number }).status, 401);
assert.equal((report.grant as { status: number }).status, 201);
assert.equal((report.callThroughProxy as { status: number }).status, 200);
assert.equal(
  (report.tokenSeenByFakeApi as { authorization: string }).authorization,
  "Bearer snowflake-real-token-abc123",
);
assert.deepEqual(
  ((report.callThroughProxy as { body: { echoedBody: unknown } }).body).echoedBody,
  { sql: "select 1" },
);
assert.equal((report.callAsUser as { status: number }).status, 200);
const auditRows = (report.audit as { body: { audit: Array<{ status: string; callerKind: string; path: string }> } }).body.audit;
assert.ok(auditRows.some((row) => row.status === "403 grant_required"), "audit must include the pre-grant 403");
assert.ok(auditRows.some((row) => row.status === "200" && row.callerKind === "app"));
assert.ok(auditRows.some((row) => row.status === "200" && row.callerKind === "user"));
assert.deepEqual(report.callAfterRevoke, {
  status: 403,
  body: {
    error: "grant_required",
    error_description: "App metrics-dashboard has no grant for integration snowflake",
    app: "metrics-dashboard",
    integration: "snowflake",
  },
});

console.log(JSON.stringify(report, null, 2));

await snowflake.close();
await issuer.close();
process.exit(0);
