import assert from "node:assert/strict";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const env = await readFile(`${root}/.env`, "utf8");
for (const line of env.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (match) process.env[match[1]!] = match[2];
}
const name = process.env.DEMO_APP_NAME ?? "real-demo";
const base = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4143";
const profile = JSON.parse(await readFile(`${root}/.alchemy-home/profiles/default/cloudflare.json`, "utf8")) as {
  values: { access: string };
};
const token = process.env.CLOUDFLARE_API_TOKEN ?? profile.values.access;
const org = "vibevarium-sandbox";
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: await readFile(resolve(root, process.env.GITHUB_APP_PRIVATE_KEY_PATH!), "utf8"),
    installationId: 184285119,
  },
});
const cloudflare = async (path: string) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.text() };
};
const jsonRequest = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const retry = async <A>(fn: () => Promise<A>, predicate: (value: A) => boolean, attempts = 15) => {
  let last: A | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last!;
};

console.log(`POST ${base}/scaffold {name:${name}}`);
const scaffold = await jsonRequest("POST", "/scaffold", { name });
assert.equal(scaffold.status, 201, JSON.stringify(scaffold.body));
console.log(JSON.stringify({
  repoUrl: scaffold.body.repoUrl,
  workerUrl: (scaffold.body.deployment as { workerUrl: string }).workerUrl,
  hostname: scaffold.body.hostname,
  discoveredTools: (scaffold.body.directoryEntry as { tools: unknown[] }).tools.length,
}, null, 2));

const commits = await octokit.rest.repos.listCommits({ owner: org, repo: name });
assert.ok(commits.data.length >= 1);
const source = await octokit.rest.repos.getContent({ owner: org, repo: name, path: "src/TicketsWorker.ts" });
assert.equal("content" in source.data && source.data.type, "file");
console.log(`GitHub: ${commits.data.length} commit(s), ${commits.data[0]?.sha}, ${commits.data[0]?.commit.message}; src/TicketsWorker.ts exists`);

const routerBase = process.env.DEMO_ROUTER_URL ?? `https://${name}.gitprops.com`;
const routerHeaders = process.env.DEMO_ROUTER_URL === undefined ? {} : { "x-forwarded-host": `${name}.gitprops.com` };
const registry = await retry(
  () => fetch(`${process.env.DEMO_ROUTER_URL ?? "https://vibevarium-router.modal-opencode-test.workers.dev"}/__registry`).then((response) => response.json() as Promise<{ apps: string[] }>),
  (body) => body.apps.includes(name),
);
console.log(`Router registry: ${JSON.stringify(registry)}`);

await retry(async () => {
  try {
    const response = await fetch(`${routerBase}/health`, { headers: routerHeaders });
    return response.status;
  } catch {
    return 0;
  }
}, (status) => status === 200, 60);

const ticketId = `router-${name}-1`;
const command = await fetch(`${routerBase}/OpenTicket`, {
  method: "POST",
  headers: { ...routerHeaders, "content-type": "application/json" },
  body: JSON.stringify({
    target: ticketId,
    input: { title: "Command through the real Vibevarium router", reporter: "real-deploy-demo" },
  }),
});
const receipt = await command.json() as { stream: string; version: number };
assert.equal(command.status, 200, JSON.stringify(receipt));
const read = await fetch(`${routerBase}/TicketById/${ticketId}?stream=${encodeURIComponent(receipt.stream)}&version=${receipt.version}`, {
  headers: routerHeaders,
});
const ticket = await read.json();
assert.equal(read.status, 200, JSON.stringify(ticket));
console.log(`Router command: ${JSON.stringify(receipt)}`);
console.log(`Router read: ${JSON.stringify(ticket)}`);

if (process.env.SKIP_DELETE !== "1") {
  console.log(`DELETE ${base}/apps/${name}`);
  const deletion = await jsonRequest("DELETE", `/apps/${name}`);
  assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
  console.log(JSON.stringify(deletion.body));
  const repo = await octokit.rest.repos.get({ owner: org, repo: name }).then(() => "present", (error: { status?: number }) => error.status === 404 ? "deleted" : `error ${error.status}`);
  const worker = await cloudflare(`/accounts/7bbaa8f97d6ababf1a5e29eb79491ce3/workers/scripts/${name}`);
  const d1 = await cloudflare(`/accounts/7bbaa8f97d6ababf1a5e29eb79491ce3/d1/database`);
  console.log(JSON.stringify({ repo, worker: { status: worker.status, body: JSON.parse(worker.body).errors }, d1ContainsApp: d1.body.includes(`${name}-data`) }, null, 2));
  assert.equal(repo, "deleted");
  assert.equal(worker.status, 404);
  assert.equal(d1.body.includes(`${name}-data`), false);
} else {
  console.log("SKIP_DELETE=1: resources retained for manual hostname/DNS checks.");
}
