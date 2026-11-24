import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { GitProvider } from "../src/scaffold/git-provider.ts";
import { GitHubAppProvider } from "../src/scaffold/github-app-provider.ts";
import { materializeCloudflareTemplate } from "../src/scaffold/template.ts";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
for (const line of await import("node:fs/promises").then((fs) => fs.readFile(join(root, ".env"), "utf8")).then((s) => s.split(/\r?\n/))) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (match) process.env[match[1]!] = match[2];
}
const required = (key: string) => {
  const value = process.env[key];
  if (value === undefined) throw new Error(`Missing ${key}`);
  return value;
};
const name = process.env.PROOF_REPO_NAME ?? `vibevarium-git-proof-${process.pid}`;
const org = "vibevarium-sandbox";
const options = {
  appId: required("GITHUB_APP_ID"),
  privateKeyPath: resolve(root, required("GITHUB_APP_PRIVATE_KEY_PATH")),
  installationId: 184285119,
  org,
  appsRoot: join(root, "apps"),
};
const files = await materializeCloudflareTemplate(join(root, "packages/template-cloudflare"), name);
const context = await Effect.runPromise(Effect.scoped(Layer.build(GitHubAppProvider.layer(options))));
const git = Context.get(context, GitProvider);
console.log(`Creating ${org}/${name} (${Object.keys(files).length} generated source files)`);
const repo = await Effect.runPromise(git.createRepo(name, files));
console.log(`Repository: ${repo.repoUrl}`);

const auth = createAppAuth({
  appId: options.appId,
  privateKey: await import("node:fs/promises").then((fs) => fs.readFile(options.privateKeyPath, "utf8")),
  installationId: options.installationId,
});
const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: options.appId, privateKey: await import("node:fs/promises").then((fs) => fs.readFile(options.privateKeyPath, "utf8")), installationId: options.installationId } });
await auth({ type: "installation" });
const commits = await octokit.rest.repos.listCommits({ owner: org, repo: name, per_page: 5 });
console.log(`Verified ${commits.data.length} commit: ${commits.data[0]?.sha} ${commits.data[0]?.commit.message}`);
console.log(`Worker source committed: ${files["src/TicketsWorker.ts"]?.includes("layerDurableObjects") === true}`);

if (process.env.KEEP_REPO !== "1") {
  if (git.deleteRepo === undefined) throw new Error("GitHub provider must implement deleteRepo");
  await Effect.runPromise(git.deleteRepo(name));
  const afterDelete = await octokit.rest.repos.get({ owner: org, repo: name }).then(() => "present", (error: { status?: number }) => error.status === 404 ? "deleted" : `error ${error.status}`);
  console.log(`Cleanup: ${afterDelete}`);
} else {
  console.log(`Local deploy directory: ${repo.directory}`);
}
