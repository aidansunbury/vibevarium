import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { attempt, ScaffoldError } from "./errors.ts";

const execFileAsync = promisify(execFile);

export interface GitRepo {
  readonly name: string;
  readonly directory: string;
  readonly repoUrl: string;
}

export interface GitProviderShape {
  readonly createRepo: (
    name: string,
    files: Readonly<Record<string, string>>,
  ) => Effect.Effect<GitRepo, ScaffoldError>;
  readonly deleteRepo?: (name: string) => Effect.Effect<void, ScaffoldError>;
}

export class GitProvider extends Context.Service<GitProvider, GitProviderShape>()(
  "@terrarium/control-plane/scaffold/GitProvider",
) {}

/** Spike provider: one independent local repository per generated app. */
export const LocalGitProvider = {
  layer: (appsRoot: string) =>
    Layer.succeed(GitProvider, GitProvider.of({
      createRepo: (name, files) =>
        attempt(async () => {
          const directory = join(appsRoot, name);
          if (await exists(directory)) {
            throw new ScaffoldError(409, `App repository already exists: ${directory}`);
          }
          for (const [relativePath, contents] of Object.entries(files)) {
            const destination = resolve(directory, relativePath);
            if (!destination.startsWith(`${resolve(directory)}${sep}`)) {
              throw new ScaffoldError(500, `Unsafe generated file path: ${relativePath}`);
            }
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, contents, "utf8");
          }
          await execFileAsync("git", ["init", "--quiet", directory]);
          await execFileAsync("git", ["-C", directory, "add", "."]);
          await execFileAsync("git", [
            "-C",
            directory,
            "-c",
            "user.name=Terrarium Scaffold",
            "-c",
            "user.email=scaffold@terrarium.local",
            "commit",
            "--quiet",
            "-m",
            "Initial scaffold",
          ]);
          return { name, directory, repoUrl: pathToFileURL(directory).href };
        }),
    })),
} as const;

const exists = async (path: string) => stat(path).then(() => true, () => false);
