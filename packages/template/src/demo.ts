import { McpClient, McpProtocol } from "effect/ai";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startTicketsServer } from "./server.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

interface Receipt {
  readonly stream: string;
  readonly version: number;
}

const requestJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
};

const atLeast = (receipt: Receipt) =>
  new URLSearchParams({ stream: receipt.stream, version: String(receipt.version) });

const exerciseHttp = async (url: string) => {
  const opened = (await requestJson(`${url}/OpenTicket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "http-1",
      input: { title: "Printer is offline", reporter: "alice" },
    }),
  })) as Receipt;
  const closed = (await requestJson(`${url}/CloseTicket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "http-1", input: {} }),
  })) as Receipt;
  const byId = await requestJson(`${url}/TicketById/http-1?${atLeast(closed)}`);
  const list = await requestJson(`${url}/TicketList/all?${atLeast(closed)}`);
  return { opened, closed, byId, list };
};

const exerciseMcp = (url: string) =>
  Effect.gen(function* () {
    const client = yield* McpClient.McpClient;
    const tools = yield* client.listTools();
    const open = tools.find((tool) => tool.name === "TicketsApi_OpenTicket_send");
    if (!open) return yield* Effect.die("OpenTicket MCP tool was not listed");
    const opened = yield* client.callTool({
      tool: open,
      arguments: {
        target: "mcp-1",
        input: { title: "Password reset is stuck", reporter: "bob" },
      },
    });
    const receipt = opened.structuredContent as Receipt;
    const byIdTool = tools.find((tool) => tool.name === "TicketsApi_TicketById_get");
    if (!byIdTool) return yield* Effect.die("TicketById MCP tool was not listed");
    const byId = yield* client.callTool({
      tool: byIdTool,
      arguments: {
        key: "mcp-1",
        atLeast: { stream: receipt.stream, version: receipt.version },
      },
    });
    return { tools, opened, byId };
  }).pipe(
    Effect.provide(
      McpClient.layerHttp({
        name: "tickets-spike",
        version: "0.0.1",
        url: `${url}/mcp`,
        protocol: McpProtocol.v2025_11_25,
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped,
  );

const runCli = (url: string, args: ReadonlyArray<string>) =>
  execFileAsync(cliPath, args, { env: { ...process.env, TICKETS_URL: url } });

const exerciseCli = async (url: string) => {
  const help = (await runCli(url, ["--help"])).stdout;
  const openedResult = await runCli(url, [
    "open-ticket",
    "--title",
    "VPN access is missing",
    "--reporter",
    "carol",
  ]);
  const opened = JSON.parse(openedResult.stdout) as Receipt;
  const ticketId = opened.stream.slice("Ticket/".length);
  const closedResult = await runCli(url, [
    "close-ticket",
    "--target",
    ticketId,
    // beta.87's toCli omits `input` for zero-field commands; supply its wire shape explicitly.
    "--json",
    JSON.stringify({ input: {} }),
  ]);
  const closed = JSON.parse(closedResult.stdout) as Receipt;
  const byId = await runCli(url, [
    "ticket-by-id",
    "get",
    "--key",
    ticketId,
    "--at-least",
    JSON.stringify({ stream: closed.stream, version: closed.version }),
  ]);
  return {
    help,
    command: `tickets open-ticket --title "VPN access is missing" --reporter carol`,
    opened: openedResult.stdout,
    closed: closedResult.stdout,
    byId: byId.stdout,
  };
};

export const runDemo = Effect.gen(function* () {
  const { url } = yield* startTicketsServer();
  const http = yield* Effect.promise(() => exerciseHttp(url));
  const mcp = yield* exerciseMcp(url);
  const cli = yield* Effect.promise(() => exerciseCli(url));
  const openApi = (yield* Effect.promise(() => requestJson(`${url}/openapi.json`))) as {
    readonly info: unknown;
    readonly paths: Record<string, unknown>;
  };
  return {
    url,
    http,
    mcp,
    cli,
    openApi: { info: openApi.info, paths: openApi.paths },
  };
});
