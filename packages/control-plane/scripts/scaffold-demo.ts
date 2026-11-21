import { startDevIssuer } from "@terrarium/dev-issuer";
import { McpClient, McpProtocol } from "effect/ai";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { allocatePort } from "../src/scaffold/processes.ts";
import type { ScaffoldResult } from "../src/scaffold/index.ts";

const execFileAsync = promisify(execFile);
const delay = promisify(setTimeout);
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = join(workspaceRoot, "packages", "control-plane");
const demoRoot = join(packageRoot, ".scaffold-demo", `run-${Date.now()}`);
const appsRoot = join(demoRoot, "apps");
const controlPlaneLog = join(demoRoot, "control-plane.log");

const mintToken = async (issuer: string, audience: string, sub = "user-1") => {
  const url = new URL("/dev/token", issuer);
  url.searchParams.set("sub", sub);
  url.searchParams.set("name", "Ada Lovelace");
  url.searchParams.set("aud", audience);
  const response = await fetch(url);
  const body = await response.json() as { access_token?: string; error_description?: string };
  assert.ok(response.ok, `Mint token failed: ${JSON.stringify(body)}`);
  assert.ok(body.access_token);
  return body.access_token;
};

const postJson = async (url: string, body: unknown) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json() as unknown;
  return { response, json };
};

const waitForControlPlane = async (url: string, child: ChildProcess) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Control plane exited before becoming healthy (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Retry until the deadline.
    }
    await delay(100);
  }
  throw new Error("Control plane did not become healthy within 20 seconds");
};

const stopChild = async (child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await exited;
};

const callThroughGateway = (gatewayUrl: string, token: string) =>
  Effect.gen(function*() {
    const client = yield* McpClient.McpClient;
    const tools = yield* client.listTools({ timeout: 10_000 });
    const open = tools.find((tool) => tool.name === "expenses_TicketsApi_OpenTicket_send");
    assert.ok(open, `Gateway did not list expenses' OpenTicket tool: ${tools.map((tool) => tool.name).join(", ")}`);
    const result = yield* client.callTool({
      tool: open,
      arguments: {
        target: "scaffold-demo-1",
        input: { title: "Created through the authenticated meta-MCP", reporter: "scaffold-demo" },
      },
    }, { timeout: 10_000 });
    return { toolNames: tools.map((tool) => tool.name), result };
  }).pipe(
    Effect.provide(McpClient.layerHttp({
      name: "terrarium-scaffold-proof",
      version: "0.0.1",
      url: `${gatewayUrl}/mcp`,
      protocol: McpProtocol.v2025_11_25,
      headers: { authorization: `Bearer ${token}` },
      timeout: 10_000,
    })),
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped,
  );

let controlPlane: ChildProcess | undefined;
let generatedProcessId: number | undefined;
let issuer: Awaited<ReturnType<typeof startDevIssuer>> | undefined;

try {
  await mkdir(appsRoot, { recursive: true });
  const audience = "expenses.terrarium.local";
  issuer = await startDevIssuer({ audiences: [audience] });
  const discoveryToken = await mintToken(issuer.issuer, audience, "discovery-service");
  const controlPlanePort = await allocatePort();
  const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`;
  const log = openSync(controlPlaneLog, "a");
  try {
    controlPlane = spawn(process.execPath, ["--experimental-strip-types", join(packageRoot, "src/main.ts")], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PORT: String(controlPlanePort),
        DISCOVERY_INTERVAL_MS: "0",
        DISCOVERY_TIMEOUT_MS: "10000",
        CALL_TIMEOUT_MS: "10000",
        DISCOVERY_TOKEN: discoveryToken,
        TERRARIUM_ISSUER: issuer.issuer,
        TERRARIUM_APPS_ROOT: appsRoot,
      },
      stdio: ["ignore", log, log],
    });
  } finally {
    closeSync(log);
  }
  await waitForControlPlane(controlPlaneUrl, controlPlane);

  const scaffoldResponse = await postJson(`${controlPlaneUrl}/scaffold`, { name: "expenses" });
  assert.equal(scaffoldResponse.response.status, 201, JSON.stringify(scaffoldResponse.json));
  const scaffold = scaffoldResponse.json as ScaffoldResult;
  generatedProcessId = scaffold.processId;
  assert.equal(scaffold.name, "expenses");
  assert.equal(scaffold.audience, audience);
  assert.equal(scaffold.directoryEntry.tools.length, 4);
  assert.equal(scaffold.directoryEntry.app.status, "up");

  const initialCommit = await execFileAsync("git", [
    "-C",
    fileURLToPath(scaffold.repoUrl),
    "log",
    "-1",
    "--pretty=%s",
  ]);

  const health = await fetch(`${scaffold.url}/health`);
  assert.equal(health.status, 200);
  const unauthenticated = await fetch(`${scaffold.url}/whoami`);
  const unauthenticatedBody = await unauthenticated.json();
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedMcp = await fetch(`${scaffold.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticatedMcp.status, 401);

  const userToken = await mintToken(issuer.issuer, audience, "user-123");
  const whoami = await fetch(`${scaffold.url}/whoami`, {
    headers: { authorization: `Bearer ${userToken}` },
  });
  const whoamiBody = await whoami.json();
  assert.equal(whoami.status, 200);
  assert.deepEqual(whoamiBody, {
    actor: { sub: "user-123", name: "Ada Lovelace" },
    auth: "on",
  });

  const directoryResponse = await fetch(`${controlPlaneUrl}/directory`);
  const directory = await directoryResponse.json() as {
    tools: Array<{ appName: string; remoteName: string; gatewayName: string; stale: boolean }>;
  };
  const expensesTools = directory.tools.filter((tool) => tool.appName === "expenses");
  assert.equal(expensesTools.length, 4);
  assert.ok(expensesTools.every((tool) => !tool.stale));

  const gateway = await Effect.runPromise(callThroughGateway(controlPlaneUrl, userToken));
  assert.equal(gateway.result.isError, false, JSON.stringify(gateway.result));
  const receipt = gateway.result.structuredContent as { stream: string; version: number };
  const readQuery = new URLSearchParams({ stream: receipt.stream, version: String(receipt.version) });
  const directRead = await fetch(`${scaffold.url}/TicketById/scaffold-demo-1?${readQuery}`, {
    headers: { authorization: `Bearer ${userToken}` },
  });
  const directReadBody = await directRead.json();
  assert.equal(directRead.status, 200);
  assert.match(JSON.stringify(directReadBody), /Created through the authenticated meta-MCP/);

  await stopChild(controlPlane, "SIGKILL");
  const afterControlPlaneKill = await fetch(`${scaffold.url}/whoami`, {
    headers: { authorization: `Bearer ${userToken}` },
  });
  const afterControlPlaneKillBody = await afterControlPlaneKill.json();
  assert.equal(afterControlPlaneKill.status, 200);

  console.log(JSON.stringify({
    scaffold: {
      name: scaffold.name,
      url: scaffold.url,
      audience: scaffold.audience,
      repoUrl: scaffold.repoUrl,
      processId: scaffold.processId,
      initialCommit: initialCommit.stdout.trim(),
      directoryEntry: {
        app: scaffold.directoryEntry.app,
        tools: expensesTools.map((tool) => ({
          remoteName: tool.remoteName,
          gatewayName: tool.gatewayName,
          stale: tool.stale,
        })),
      },
    },
    auth: {
      healthStatus: health.status,
      unauthenticatedWhoAmi: { status: unauthenticated.status, body: unauthenticatedBody },
      unauthenticatedMcpStatus: unauthenticatedMcp.status,
      authenticatedWhoAmi: { status: whoami.status, body: whoamiBody },
    },
    gateway: {
      directoryToolNames: expensesTools.map((tool) => tool.gatewayName),
      callThrough: gateway.result,
      directReadAfterCall: directReadBody,
    },
    independentProcess: {
      controlPlane: "SIGKILL (no graceful cleanup)",
      appWhoAmiAfterControlPlaneKill: {
        status: afterControlPlaneKill.status,
        body: afterControlPlaneKillBody,
      },
    },
    artifacts: {
      appLog: fileURLToPath(scaffold.repoUrl) + "/app.log",
      controlPlaneLog,
      note: "The demo cleans up its generated process after printing; the local git repo and logs are retained.",
    },
  }, null, 2));
} finally {
  if (controlPlane !== undefined) await stopChild(controlPlane).catch(() => {});
  if (generatedProcessId === undefined) {
    generatedProcessId = await readFile(join(appsRoot, "expenses", "app.pid"), "utf8")
      .then((pid) => Number.parseInt(pid, 10))
      .catch(() => undefined);
  }
  if (generatedProcessId !== undefined && Number.isInteger(generatedProcessId)) {
    try {
      process.kill(-generatedProcessId, "SIGKILL");
    } catch {
      // The app may already have exited or been stopped by graceful control-plane cleanup.
    }
  }
  if (issuer !== undefined) await issuer.close();
}
