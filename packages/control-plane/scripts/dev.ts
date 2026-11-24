/**
 * Local-dev orchestrator: one command boots the whole local platform.
 *
 *   pnpm --filter @vibevarium/control-plane dev
 *
 * Boots the dev OIDC issuer, the control plane (PGlite, auth on, GUI served
 * from web/dist), and one template app (the localhost twin at
 * <name>.vibevarium.local audience), then registers the app and runs
 * discovery so the gateway directory is warm. Prints the URL map and keeps
 * everything alive until Ctrl+C, with clean shutdown.
 *
 * Env knobs (all optional):
 *   PORT (4100)            control-plane port
 *   OIDC_PORT (4010)       dev-issuer port
 *   APP_PORT (4300)        template app port
 *   APP_NAME (tickets)     app name → audience <name>.vibevarium.local
 *   DATABASE_PATH          PGlite dir (default .data/dev-control-plane)
 */
import { startDevIssuer } from "@vibevarium/dev-issuer";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const delay = promisify(setTimeout);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = join(packageRoot, "..", "..");

const CONTROL_PORT = Number(process.env.PORT ?? 4100);
const ISSUER_PORT = Number(process.env.OIDC_PORT ?? 4010);
const APP_PORT = Number(process.env.APP_PORT ?? 4300);
const APP_NAME = process.env.APP_NAME ?? "tickets";
const DOMAIN = process.env.TERRARIUM_DOMAIN ?? "vibevarium.local";
const CONTROL_AUDIENCE = `control.${DOMAIN}`;
const APP_AUDIENCE = `${APP_NAME}.${DOMAIN}`;
const ISSUER = `http://127.0.0.1:${ISSUER_PORT}`;
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const APP_SECRET = process.env.APP_SECRET ?? "dev-tickets-secret";

const children: Array<{ name: string; child: ChildProcess }> = [];
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] ${signal} — stopping…`);
  await Promise.all(children.map(({ name, child }) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000).unref();
      console.log(`[dev] stopping ${name}`);
    })
  ));
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const waitFor = async (name: string, url: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(100);
  }
  throw new Error(`${name} did not become healthy at ${url}`);
};

const mintToken = async (audience: string, sub: string) => {
  const url = new URL("/dev/token", ISSUER);
  url.searchParams.set("sub", sub);
  url.searchParams.set("name", sub === "discovery-service" ? "Discovery service" : "Ada Lovelace");
  url.searchParams.set("aud", audience);
  const response = await fetch(url);
  const body = await response.json() as { access_token?: string };
  assert.ok(response.ok && body.access_token);
  return body.access_token;
};

// 1. Dev OIDC issuer (in-process: it is a tiny plain-Node server).
const issuer = await startDevIssuer({
  port: ISSUER_PORT,
  issuer: ISSUER,
  audiences: [CONTROL_AUDIENCE, APP_AUDIENCE],
});
console.log(`[dev] dev-issuer   ${issuer.issuer}`);

// 2. Control plane (subprocess so its logs stay separate; PGlite durable dir).
const databasePath = process.env.DATABASE_PATH ?? join(packageRoot, ".data/dev-control-plane");
await mkdir(databasePath, { recursive: true });
const controlPlane = spawn(
  process.execPath,
  ["--experimental-strip-types", join(packageRoot, "src/main.ts")],
  {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      PORT: String(CONTROL_PORT),
      DATABASE_PATH: databasePath,
      DISCOVERY_INTERVAL_MS: "0",
      DISCOVERY_TIMEOUT_MS: "10000",
      CALL_TIMEOUT_MS: "10000",
      DISCOVERY_TOKEN: await mintToken(APP_AUDIENCE, "discovery-service"),
      TERRARIUM_ISSUER: ISSUER,
      CONTROL_PLANE_ISSUER: ISSUER,
      CONTROL_PLANE_AUDIENCE: CONTROL_AUDIENCE,
      APP_SECRETS: JSON.stringify({ [APP_NAME]: APP_SECRET }),
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
children.push({ name: "control-plane", child: controlPlane });
await waitFor("control-plane", `${CONTROL}/health`);
console.log(`[dev] control-plane ${CONTROL} (GUI ${CONTROL}/)`);

// 3. One template app (the localhost twin; verifies its own audience).
const app = spawn(
  process.execPath,
  ["--experimental-strip-types", join(workspaceRoot, "packages/template/src/main.ts")],
  {
    cwd: join(workspaceRoot, "packages/template"),
    env: {
      ...process.env,
      APP_NAME,
      PORT: String(APP_PORT),
      TERRARIUM_AUTH: "on",
      TERRARIUM_ISSUER: ISSUER,
      TERRARIUM_AUDIENCE: APP_AUDIENCE,
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
children.push({ name: APP_NAME, child: app });
await waitFor(APP_NAME, `http://127.0.0.1:${APP_PORT}/health`);
console.log(`[dev] app (${APP_NAME}) http://127.0.0.1:${APP_PORT} (audience ${APP_AUDIENCE})`);

// 4. Register + discover so the gateway directory is warm.
const adminToken = await mintToken(CONTROL_AUDIENCE, "user-ada");
const adminHeaders = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
const registered = await fetch(`${CONTROL}/apps`, {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify({ name: APP_NAME, url: `http://127.0.0.1:${APP_PORT}/mcp` }),
});
assert.ok(registered.ok, `register failed: ${registered.status} ${await registered.text()}`);
const discovered = await fetch(`${CONTROL}/discover`, { method: "POST", headers: adminHeaders, body: "{}" });
const discovery = await discovered.json() as { results: Array<{ name: string; status: string; toolCount?: number }> };
console.log(`[dev] discovery    ${JSON.stringify(discovery.results)}`);

console.log(`
[dev] URL map
  GUI:          ${CONTROL}/               (login button mints a dev token)
  MCP gateway:  ${CONTROL}/mcp            (Bearer ${CONTROL_AUDIENCE} token)
  App:          http://127.0.0.1:${APP_PORT}/mcp (audience ${APP_AUDIENCE})
  Dev issuer:   ${ISSUER}/dev/token?sub=user-1&name=Ada&aud=${CONTROL_AUDIENCE}
  App secret:   ${APP_NAME} / ${APP_SECRET}  (integration proxy placeholder)
[dev] Ctrl+C stops everything cleanly.
`);
