import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { attempt, ScaffoldError } from "./errors.ts";

const alchemyCli = createRequire(import.meta.url).resolve("alchemy/bin/alchemy.js");
const execFileAsync = promisify(execFile);

export class RouterBindings {
  readonly #workspaceRoot: string;
  readonly #accountId: string;
  readonly #routerFile: string;

  constructor(workspaceRoot: string, accountId: string) {
    this.#workspaceRoot = workspaceRoot;
    this.#accountId = accountId;
    this.#routerFile = join(workspaceRoot, "packages/control-plane/src/router/src/RouterWorker.ts");
  }

  private async deploy(): Promise<void> {
    await execFileAsync(process.execPath, [
      alchemyCli,
      "deploy",
      "--config",
      "src/router/alchemy.run.ts",
      "--no-input",
      "--yes",
      // The router worker pre-exists (REAL-SPIKE); its local state was lost
      // when the box churned, so adopt it into this stack's fresh state.
      "--adopt",
      "--include",
      "RouterWorker",
    ], {
      cwd: join(this.#workspaceRoot, "packages/control-plane"),
      env: { ...process.env, CI: "1", CLOUDFLARE_ACCOUNT_ID: this.#accountId },
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    }).catch((cause: { stdout?: string; stderr?: string; message?: string }) => {
      throw new ScaffoldError(502, `Router binding deploy failed: ${cause.stdout ?? ""}${cause.stderr ?? cause.message}`);
    });
  }

  async remove(name: string): Promise<void> {
    const source = await readFile(this.#routerFile, "utf8");
    if (!source.includes(`"APP_${name}":`)) return;
    const updated = source.replace(`  "APP_${name}": Cloudflare.Worker.lookup({ name: "${name}" }),\n`, "");
    await writeFile(this.#routerFile, updated, "utf8");
    await this.deploy();
  }

  async add(name: string): Promise<void> {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      throw new ScaffoldError(400, "Invalid app name for a Cloudflare service binding");
    }
    const source = await readFile(this.#routerFile, "utf8");
    if (source.includes(`"APP_${name}":`)) return;
    const updated = source.replace(
      "export const AppWorkers: Record<string, ReturnType<typeof Cloudflare.Worker.lookup>> = {",
      `export const AppWorkers: Record<string, ReturnType<typeof Cloudflare.Worker.lookup>> = {\n  "APP_${name}": Cloudflare.Worker.lookup({ name: "${name}" }),`,
    );
    if (updated === source) throw new ScaffoldError(500, "Could not update the router service binding");
    await writeFile(this.#routerFile, updated, "utf8");
    await this.deploy();
  }
}

export const loadRouterBindings = (workspaceRoot: string, accountId: string) =>
  attempt(() => Promise.resolve(new RouterBindings(workspaceRoot, accountId)));
