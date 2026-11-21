import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { startDevIssuer } from "@terrarium/dev-issuer";
import { startTicketsServer } from "@terrarium/template/server";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createServer, request } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const composedCli = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const dynamicCli = fileURLToPath(new URL("../src/dynamic.ts", import.meta.url));

const Receipt = Schema.Struct({ stream: Schema.String, version: Schema.Number });
const Ticket = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  reporter: Schema.String,
  status: Schema.String,
});
const TicketList = Schema.Struct({ tickets: Schema.Array(Ticket) });
const CachedToken = Schema.Struct({ accessToken: Schema.String, tokenType: Schema.String });
const Whoami = Schema.Struct({ subject: Schema.String });

type CachedToken = typeof CachedToken.Type;

const decodeReceipt = Schema.decodeUnknownSync(Receipt);
const decodeTicket = Schema.decodeUnknownSync(Ticket);
const decodeTicketList = Schema.decodeUnknownSync(TicketList);
const decodeCachedToken = Schema.decodeUnknownSync(CachedToken);
const decodeWhoami = Schema.decodeUnknownSync(Whoami);
const parseJson = (text: string): unknown => JSON.parse(text);

interface Observation {
  readonly method: string | undefined;
  readonly path: string;
  readonly authorization: string | undefined;
}

const startAuthProxy = async (targetUrl: string) => {
  const observations: Array<Observation> = [];
  const target = new URL(targetUrl);
  const server = createServer((incoming, outgoing) => {
    observations.push({
      method: incoming.method,
      path: incoming.url ?? "/",
      authorization: incoming.headers.authorization,
    });
    const upstream = request(
      new URL(incoming.url ?? "/", target),
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: target.host },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(String(error));
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    observations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const shellArg = (value: string) => (value.includes(" ") ? JSON.stringify(value) : value);

const makeRunner = (environment: NodeJS.ProcessEnv) => {
  const run = async (entry: "composed" | "dynamic", args: ReadonlyArray<string>) => {
    const cli = entry === "composed" ? composedCli : dynamicCli;
    const executable = entry === "composed" ? "platform" : "platform-dynamic";
    const result = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cli, ...args],
      { env: environment, encoding: "utf8" },
    );
    return {
      command: `${executable} ${args.map(shellArg).join(" ")}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return run;
};

const authEvidence = (observations: ReadonlyArray<Observation>, token: CachedToken) => {
  assert(observations.length > 0, "the proxy should observe RPC calls");
  return observations.map((observation) => {
    assert.equal(
      observation.authorization,
      `${token.tokenType} ${token.accessToken}`,
      "the app transport must receive the exact cached SSO token",
    );
    return {
      ...observation,
      authorization: `Bearer ${token.accessToken.slice(0, 24)}…<redacted>`,
      matchesCachedToken: true,
    };
  });
};

const demo = Effect.gen(function* () {
  const tickets = yield* startTicketsServer();
  const issuer = yield* Effect.acquireRelease(
    Effect.promise(() => startDevIssuer({ audiences: ["my-app"] })),
    (started) => Effect.promise(() => started.close()),
  );
  const proxy = yield* Effect.acquireRelease(
    Effect.promise(() => startAuthProxy(tickets.url)),
    (started) => Effect.promise(() => started.close()),
  );
  const configDirectory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join("/tmp/opencode", "terrarium-cli-demo-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  const environment = {
    ...process.env,
    TERRARIUM_CONFIG_DIR: configDirectory,
    PLATFORM_OIDC_ISSUER: issuer.issuer,
    PLATFORM_OIDC_AUDIENCE: "my-app",
    PLATFORM_TICKETS_URL: proxy.url,
  };
  const run = makeRunner(environment);

  return yield* Effect.promise(async () => {
    const login = await run("composed", ["login"]);
    const authFile = join(configDirectory, "auth.json");
    const token = decodeCachedToken(parseJson(await readFile(authFile, "utf8")));
    const authMode = (await stat(authFile)).mode & 0o777;
    assert.equal(authMode, 0o600, "auth.json must be private to the user");

    const exercise = async (entry: "composed" | "dynamic", title: string) => {
      const firstObservation = proxy.observations.length;
      const openedCall = await run(entry, [
        "tickets",
        "open-ticket",
        "--title",
        title,
        "--reporter",
        "ada",
      ]);
      const opened = decodeReceipt(parseJson(openedCall.stdout));
      assert.match(opened.stream, /^Ticket\/[0-9a-f-]{36}$/);
      assert.equal(opened.version, 1);
      const ticketId = opened.stream.slice("Ticket/".length);
      const atLeast = JSON.stringify({ stream: opened.stream, version: opened.version });

      const getCall = await run(entry, [
        "tickets",
        "ticket-by-id",
        "get",
        "--key",
        ticketId,
        "--at-least",
        atLeast,
      ]);
      const byId = decodeTicket(parseJson(getCall.stdout));
      assert.equal(byId.id, ticketId);
      assert.equal(byId.title, title);
      assert.equal(byId.reporter, "ada");

      const listCall = await run(entry, [
        "tickets",
        "ticket-list",
        "get",
        "--key",
        "all",
        "--at-least",
        atLeast,
      ]);
      const list = decodeTicketList(parseJson(listCall.stdout));
      assert(list.tickets.some((ticket) => ticket.id === ticketId));

      return {
        ticketId,
        open: { command: openedCall.command, output: opened },
        get: { command: getCall.command, output: byId },
        list: { command: listCall.command, output: list },
        receivedAuthorization: authEvidence(proxy.observations.slice(firstObservation), token),
      };
    };

    const composed = await exercise("composed", "composed mega-CLI ticket");
    const addApp = await run("dynamic", [
      "apps",
      "add",
      "tickets",
      "@terrarium/template",
      proxy.url,
    ]);
    const manifest = parseJson(await readFile(join(configDirectory, "apps.json"), "utf8"));
    const whoamiCall = await run("dynamic", ["whoami"]);
    const whoami = decodeWhoami(parseJson(whoamiCall.stdout));
    assert.equal(whoami.subject, "user-1");
    const dynamic = await exercise("dynamic", "dynamic mega-CLI ticket");
    assert.notEqual(composed.ticketId, dynamic.ticketId);
    const logout = await run("dynamic", ["logout"]);
    await assert.rejects(stat(authFile), { code: "ENOENT" });

    return {
      login: { command: login.command, output: login.stdout.trim() },
      authFileMode: authMode.toString(8).padStart(4, "0"),
      composed,
      appsAdd: { command: addApp.command, output: addApp.stdout.trim(), manifest },
      whoami: { command: whoamiCall.command, output: whoami },
      dynamic,
      logout: { command: logout.command, output: logout.stdout.trim() },
      result: "PASS: both variants returned real ticket ids and every RPC carried the same SSO bearer token",
    };
  });
});

NodeRuntime.runMain(
  Effect.scoped(demo).pipe(
    Effect.tap((report) => Effect.sync(() => console.log(JSON.stringify(report, null, 2)))),
  ),
);
