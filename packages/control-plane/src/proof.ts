import { startTicketsServer } from "@terrarium/template/server";
import assert from "node:assert/strict";
import { McpClient, McpProtocol } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { DIRECTORY_LIST_APPS, DIRECTORY_SEARCH_TOOLS } from "./gateway/tools.ts";
import { startControlPlane } from "./server.ts";

const OPEN_TICKET = "TicketsApi_OpenTicket_send";
const A_OPEN_TICKET = `tickets-a_${OPEN_TICKET}`;
const B_OPEN_TICKET = `tickets-b_${OPEN_TICKET}`;
const MARKER = "proof-from-agent";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

const AppRegistrationJson = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  status: Schema.Literals(["unknown", "up", "down"]),
  lastSeenAt: Schema.NullOr(Schema.String),
  lastCheckedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});

const DirectorySnapshot = Schema.Struct({
  apps: Schema.Array(AppRegistrationJson),
  tools: Schema.Array(Schema.Struct({
    appName: Schema.String,
    appUrl: Schema.String,
    appStatus: Schema.Literals(["unknown", "up", "down"]),
    remoteName: Schema.String,
    gatewayName: Schema.String,
    descriptor: McpSchema.Tool,
    discoveredAt: Schema.String,
    stale: Schema.Boolean,
  })),
});

const DiscoveryResponse = Schema.Struct({
  results: Schema.Array(Schema.Union([
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literal("up"),
      toolCount: Schema.Number,
      discoveredAt: Schema.String,
    }),
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literal("down"),
      error: Schema.Struct({ _tag: Schema.String, message: Schema.String }),
      retainedToolCount: Schema.Number,
    }),
  ])),
});

const requestJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const body = await response.json() as unknown;
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
};

const postJson = (url: string, body: unknown) =>
  requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const Receipt = Schema.Struct({
  reply: Schema.Null,
  stream: Schema.String,
  version: Schema.Number,
});

const requiredTool = (tools: ReadonlyArray<McpSchema.Tool>, name: string) => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected gateway tool ${name}; got ${tools.map((candidate) => candidate.name).join(", ")}`);
  return tool;
};

const atLeast = (receipt: typeof Receipt.Type) =>
  new URLSearchParams({ stream: receipt.stream, version: String(receipt.version) });

const makeRecordingFetch = (requests: Array<RecordedRequest>): typeof globalThis.fetch =>
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = request.method === "POST" ? await request.clone().text() : undefined;
      let body: unknown = text;
      if (text !== undefined) {
        try {
          body = JSON.parse(text);
        } catch {
          // Keep non-JSON bodies as text in the transport ledger.
        }
      }
      requests.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        ...(text === undefined ? {} : { body }),
      });
      return globalThis.fetch(request);
    },
    { preconnect() {} },
  );

const childToolCalls = (requests: ReadonlyArray<RecordedRequest>, appUrl: string) =>
  requests.filter((request) => {
    if (request.url !== `${appUrl}/mcp` || !Predicate.isReadonlyObject(request.body)) return false;
    if (request.body.method !== "tools/call" || !Predicate.isReadonlyObject(request.body.params)) return false;
    return request.body.params.name === OPEN_TICKET;
  });

export const runGatewayProof = Effect.gen(function*() {
  const transportLedger: Array<RecordedRequest> = [];
  const scopeA = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
  const scopeB = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
  const appA = yield* startTicketsServer().pipe(Effect.provideService(Scope.Scope, scopeA));
  const appB = yield* startTicketsServer().pipe(Effect.provideService(Scope.Scope, scopeB));
  const gateway = yield* startControlPlane({
    discoveryIntervalMs: 0,
    discoveryTimeoutMs: 1_000,
    callTimeoutMs: 750,
    fetch: makeRecordingFetch(transportLedger),
  });

  yield* Effect.promise(() => postJson(`${gateway.url}/apps`, { name: "tickets-a", url: `${appA.url}/mcp` }));
  yield* Effect.promise(() => postJson(`${gateway.url}/apps`, { name: "tickets-b", url: `${appB.url}/mcp` }));
  const initialDiscovery = Schema.decodeUnknownSync(DiscoveryResponse)(yield* Effect.promise(() =>
    postJson(`${gateway.url}/discover`, undefined)
  ));
  const initialDirectory = Schema.decodeUnknownSync(DirectorySnapshot)(yield* Effect.promise(() =>
    requestJson(`${gateway.url}/directory`)
  ));

  const clientContext = yield* Layer.build(
    McpClient.layerHttp({
      name: "terrarium-gateway-proof",
      version: "0.0.1",
      url: `${gateway.url}/mcp`,
      protocol: McpProtocol.v2025_11_25,
      headers: { authorization: "Bearer proof-token", "x-spike-marker": MARKER },
      timeout: 5_000,
    }).pipe(Layer.provide(FetchHttpClient.layer)),
  );
  const client = Context.get(clientContext, McpClient.McpClient);
  const initialTools = yield* client.listTools();
  const aOpen = requiredTool(initialTools, A_OPEN_TICKET);
  requiredTool(initialTools, B_OPEN_TICKET);

  const directoryApps = yield* client.callTool({ tool: requiredTool(initialTools, DIRECTORY_LIST_APPS) });
  const directorySearch = yield* client.callTool({
    tool: requiredTool(initialTools, DIRECTORY_SEARCH_TOOLS),
    arguments: { query: "open a support ticket" },
  });

  const openedA = yield* client.callTool({
    tool: aOpen,
    arguments: {
      target: "proof-a-1",
      input: { title: "Created through meta-MCP in app A", reporter: "gateway-proof" },
    },
  }, { timeout: 5_000 });
  const receiptA = Schema.decodeUnknownSync(Receipt)(openedA.structuredContent);
  const ticketA = yield* Effect.promise(() =>
    requestJson(`${appA.url}/TicketById/proof-a-1?${atLeast(receiptA)}`)
  );

  yield* Scope.close(scopeB, Exit.void);

  const afterKillDiscovery = Schema.decodeUnknownSync(DiscoveryResponse)(yield* Effect.promise(() =>
    postJson(`${gateway.url}/discover`, undefined)
  ));
  const afterKillDirectory = Schema.decodeUnknownSync(DirectorySnapshot)(yield* Effect.promise(() =>
    requestJson(`${gateway.url}/directory`)
  ));
  const afterKillTools = yield* client.listTools();
  const bOpenAfterKill = requiredTool(afterKillTools, B_OPEN_TICKET);

  const bStartedAt = yield* Clock.currentTimeMillis;
  const bCallAfterKill = yield* client.callTool({
    tool: bOpenAfterKill,
    arguments: {
      target: "proof-b-unreachable",
      input: { title: "This must not be created", reporter: "gateway-proof" },
    },
  }, { timeout: 5_000 });
  const bCallDurationMs = (yield* Clock.currentTimeMillis) - bStartedAt;

  const aOpenAfterKill = requiredTool(afterKillTools, A_OPEN_TICKET);
  const openedAAfterKill = yield* client.callTool({
    tool: aOpenAfterKill,
    arguments: {
      target: "proof-a-2",
      input: { title: "App A still works after app B died", reporter: "gateway-proof" },
    },
  }, { timeout: 5_000 });
  const receiptAAfterKill = Schema.decodeUnknownSync(Receipt)(openedAAfterKill.structuredContent);
  const ticketAAfterKill = yield* Effect.promise(() =>
    requestJson(`${appA.url}/TicketById/proof-a-2?${atLeast(receiptAAfterKill)}`)
  );

  const forwardedCalls = childToolCalls(transportLedger, appA.url).filter((request) =>
    request.headers["x-spike-marker"] === MARKER
  );
  const forwardedHeaderProof = forwardedCalls[0];
  const bRow = afterKillDirectory.apps.find((app) => app.name === "tickets-b");
  const bTools = afterKillDirectory.tools.filter((tool) => tool.appName === "tickets-b");
  const bError = Predicate.isReadonlyObject(bCallAfterKill.structuredContent) &&
      Predicate.isReadonlyObject(bCallAfterKill.structuredContent.error)
    ? bCallAfterKill.structuredContent.error
    : undefined;

  yield* Effect.sync(() => {
    assert.deepEqual(initialDiscovery.results.map((result) => [result.name, result.status]), [
      ["tickets-a", "up"],
      ["tickets-b", "up"],
    ]);
    assert.equal(initialTools.length, 10, "8 app tools plus 2 directory tools");
    for (const name of [
      "tickets-a_TicketsApi_OpenTicket_send",
      "tickets-a_TicketsApi_CloseTicket_send",
      "tickets-a_TicketsApi_TicketById_get",
      "tickets-a_TicketsApi_TicketList_get",
      "tickets-b_TicketsApi_OpenTicket_send",
      "tickets-b_TicketsApi_CloseTicket_send",
      "tickets-b_TicketsApi_TicketById_get",
      "tickets-b_TicketsApi_TicketList_get",
    ]) requiredTool(initialTools, name);

    const originalOpen = initialDirectory.tools.find((tool) =>
      tool.appName === "tickets-a" && tool.remoteName === OPEN_TICKET
    );
    assert.ok(originalOpen);
    assert.deepEqual(aOpen.inputSchema, originalOpen.descriptor.inputSchema, "input JSON Schema must pass through intact");
    assert.deepEqual(aOpen.outputSchema, originalOpen.descriptor.outputSchema, "output JSON Schema must pass through intact");
    assert.deepEqual(aOpen.annotations, originalOpen.descriptor.annotations);
    assert.equal(aOpen.description, originalOpen.descriptor.description);

    assert.equal(openedA.isError, false);
    assert.equal(receiptA.stream, "Ticket/proof-a-1");
    assert.match(JSON.stringify(ticketA), /Created through meta-MCP in app A/);
    assert.equal(directoryApps.isError, false);
    assert.match(JSON.stringify(directoryApps.structuredContent), /tickets-a/);
    assert.equal(directorySearch.isError, false);
    assert.match(JSON.stringify(directorySearch.structuredContent), /tickets-a_TicketsApi_OpenTicket_send/);
    assert.match(JSON.stringify(directorySearch.structuredContent), /tickets-b_TicketsApi_OpenTicket_send/);

    assert.equal(afterKillDiscovery.results.find((result) => result.name === "tickets-a")?.status, "up");
    assert.equal(afterKillDiscovery.results.find((result) => result.name === "tickets-b")?.status, "down");
    assert.equal(bRow?.status, "down");
    assert.ok(bRow?.lastSeenAt, "last successful discovery timestamp must be retained");
    assert.equal(bTools.length, 4);
    assert.ok(bTools.every((tool) => tool.stale));
    requiredTool(afterKillTools, B_OPEN_TICKET);
    assert.ok(afterKillTools.filter((tool) => tool.name.startsWith("tickets-b_")).every((tool) =>
      tool["_meta"]?.["terrarium/stale"] === true
    ));
    assert.equal(bCallAfterKill.isError, true);
    assert.equal(bError?.["_tag"], "AppUnavailable");
    assert.ok(bCallDurationMs < 3_000, `down-app call took ${bCallDurationMs}ms`);

    assert.equal(openedAAfterKill.isError, false);
    assert.equal(receiptAAfterKill.stream, "Ticket/proof-a-2");
    assert.match(JSON.stringify(ticketAAfterKill), /App A still works after app B died/);

    assert.ok(forwardedHeaderProof, "the child MCP transport must carry the caller marker header");
    assert.equal(forwardedHeaderProof.headers.authorization, "Bearer proof-token");
    assert.equal(forwardedHeaderProof.headers["x-spike-marker"], MARKER);
  });

  return {
    gatewayUrl: gateway.url,
    appAUrl: appA.url,
    appBUrl: appB.url,
    initialDiscovery: initialDiscovery.results,
    gatewayToolsList: { tools: initialTools },
    directoryTools: {
      listApps: directoryApps,
      searchOpenTicket: directorySearch,
    },
    callThroughGatewayToA: openedA,
    ticketReadDirectlyFromA: ticketA,
    headerForwarding: {
      mechanism: "Recorded the real Fetch request made by effect/ai McpClient to app A; the template has no header-echo tool.",
      observedChildRequest: forwardedHeaderProof,
    },
    killAppB: {
      discovery: afterKillDiscovery.results,
      registryRow: bRow,
      retainedTools: bTools.map((tool) => ({ gatewayName: tool.gatewayName, stale: tool.stale })),
      gatewayStillLists: afterKillTools.filter((tool) => tool.name.startsWith("tickets-b_")).map((tool) => tool.name),
      bCallDurationMs,
      bCallResult: bCallAfterKill,
      aCallResultAfterBKilled: openedAAfterKill,
      ticketAReadDirectlyAfterBKilled: ticketAAfterKill,
    },
  };
});
