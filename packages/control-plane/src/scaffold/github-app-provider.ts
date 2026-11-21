import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import * as Layer from "effect/Layer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { attempt, ScaffoldError } from "./errors.ts";
import { GitProvider, type GitProviderShape } from "./git-provider.ts";

export interface GitHubAppProviderOptions {
  readonly appId: string;
  readonly privateKeyPath: string;
  readonly installationId: number;
  readonly org: string;
  readonly appsRoot: string;
}

const asError = (cause: unknown, status = 502) => new ScaffoldError(
  status,
  cause instanceof Error ? cause.message : String(cause),
  { cause },
);

/** Real repositories owned by the Terrarium GitHub App installation. */
export const GitHubAppProvider = {
  layer: (options: GitHubAppProviderOptions) =>
    Layer.unwrap(attempt(async () => {
      const privateKey = await readFile(resolve(options.privateKeyPath), "utf8");
      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: options.appId,
          privateKey,
          installationId: options.installationId,
        },
      });
      const shape: GitProviderShape = {
        createRepo: (name, files) => attempt(async () => {
          const directory = join(options.appsRoot, name);
          await mkdir(directory, { recursive: true });
          const created = await octokit.rest.repos.createInOrg({
            org: options.org,
            name,
            private: true,
            auto_init: false,
            description: "A Terrarium-generated Cloudflare Durable Objects app",
          }).catch((cause: { status?: number }) => {
            throw asError(cause, cause.status === 422 ? 409 : 502);
          });
          try {
            // GitHub rejects the Git Data API while a repository has no refs.
            // Bootstrap one ref, then replace it with the single root commit below.
            await octokit.rest.repos.createOrUpdateFileContents({
              owner: options.org,
              repo: name,
              path: ".gitignore",
              message: "Initial scaffold",
              content: Buffer.from(files[".gitignore"] ?? "node_modules/\n").toString("base64"),
            });
            const tree = [];
            for (const [filePath, content] of Object.entries(files)) {
              const destination = resolve(directory, filePath);
              if (!destination.startsWith(`${directory}${sep}`)) {
                throw new ScaffoldError(500, `Unsafe generated file path: ${filePath}`);
              }
              await mkdir(dirname(destination), { recursive: true });
              await writeFile(destination, content, "utf8");
              const blob = await octokit.rest.git.createBlob({
                owner: options.org,
                repo: name,
                content: Buffer.from(content).toString("base64"),
                encoding: "base64",
              });
              tree.push({
                path: filePath,
                mode: "100644" as const,
                type: "blob" as const,
                sha: blob.data.sha,
              });
            }
            const rootTree = await octokit.rest.git.createTree({
              owner: options.org,
              repo: name,
              tree,
            });
            const commit = await octokit.rest.git.createCommit({
              owner: options.org,
              repo: name,
              message: "Initial scaffold",
              tree: rootTree.data.sha,
              parents: [],
            });
            await octokit.rest.git.updateRef({
              owner: options.org,
              repo: name,
              ref: "heads/main",
              sha: commit.data.sha,
              force: true,
            });
          } catch (cause) {
            await octokit.rest.repos.delete({ owner: options.org, repo: name }).catch(() => {});
            throw asError(cause);
          }
          return { name, directory, repoUrl: created.data.html_url };
        }),
        deleteRepo: (name) => attempt(async () => {
          await octokit.rest.repos.delete({ owner: options.org, repo: name }).catch(
            (cause: { status?: number }) => {
              if (cause.status !== 404) throw cause;
            },
          );
        }, 502),
      };
      return Layer.succeed(GitProvider, GitProvider.of(shape));
    })),
} as const;
