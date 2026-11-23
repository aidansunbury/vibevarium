import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { attempt, ScaffoldError } from "./errors.ts";

const execFileAsync = promisify(execFile);
const alchemyCli = createRequire(import.meta.url).resolve("alchemy/bin/alchemy.js");

export interface CloudflareDeployerOptions {
  readonly accountId: string;
  readonly alchemyHome: string;
  readonly workersSubdomain: string;
  /** Base domain app hostnames hang off of, e.g. `vibevarium.com`. */
  readonly domain: string;
  readonly packageManager?: "pnpm" | "symlink" | undefined;
}

export interface CloudflareDeployment {
  readonly name: string;
  readonly directory: string;
  readonly workerName: string;
  readonly workerUrl: string;
  readonly hostname: string;
  readonly databaseName: string;
}

export class CloudflareDeployer {
  readonly #options: CloudflareDeployerOptions;

  constructor(options: CloudflareDeployerOptions) {
    this.#options = options;
  }

  private env(name: string, oidcClient?: { readonly clientId: string; readonly clientSecret: string }) {
    return {
      ...process.env,
      // Containers have no interactive alchemy profile; CI=1 makes alchemy
      // resolve credentials from environment variables (CLOUDFLARE_API_TOKEN).
      CI: "1",
      ALCHEMY_HOME: this.#options.alchemyHome,
      CLOUDFLARE_ACCOUNT_ID: this.#options.accountId,
      STACK_NAME: `terrarium-${name}`,
      WORKER_NAME: name,
      D1_DATABASE_NAME: `${name}-data`,
      APP_HOSTNAME: `${name}.${this.#options.domain}`,
      // Option B′: the app's own audience + the platform audience it also accepts.
      TERRARIUM_AUDIENCE: `${name}.${this.#options.domain}`,
      TERRARIUM_PLATFORM_AUDIENCE: `https://mcp.${this.#options.domain}`,
      ...(oidcClient === undefined ? {} : {
        TERRARIUM_CLIENT_ID: oidcClient.clientId,
        TERRARIUM_CLIENT_SECRET: oidcClient.clientSecret,
      }),
    };
  }

  private async alchemy(
    command: "deploy" | "destroy",
    deployment: CloudflareDeployment,
    oidcClient?: { readonly clientId: string; readonly clientSecret: string },
  ) {
    if (this.#options.packageManager === "pnpm") {
      await execFileAsync("pnpm", ["install", "--frozen-lockfile=false"], {
        cwd: deployment.directory,
        env: this.env(deployment.name, oidcClient),
        timeout: 3 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } else {
      const template = createRequire(import.meta.url).resolve("terrarium-tickets-cloudflare/package.json");
      const dependencies = join(dirname(template), "node_modules");
      if (!existsSync(join(deployment.directory, "node_modules"))) {
        await symlink(dependencies, join(deployment.directory, "node_modules"), "dir");
      }
    }
    let lastOutput = "";
    for (let retryIndex = 0; retryIndex < (command === "deploy" ? 3 : 1); retryIndex++) {
      try {
        return await execFileAsync(process.execPath, [alchemyCli, command, "--no-input", "--yes"], {
          cwd: deployment.directory,
          env: this.env(deployment.name, oidcClient),
          timeout: 5 * 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (cause) {
        const error = cause as { stdout?: string; stderr?: string; message?: string };
        lastOutput = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
        if (!lastOutput.includes("InstanceNotFound")) break;
        console.warn(`Alchemy ${command}: transient Workflow InstanceNotFound; retrying (${retryIndex + 1}/3)`);
      }
    }
    throw new ScaffoldError(502, `Alchemy ${command} failed for ${deployment.name}:\n${lastOutput}`);
  }

  async deploy(
    name: string,
    directory: string,
    oidcClient?: { readonly clientId: string; readonly clientSecret: string },
  ): Promise<CloudflareDeployment> {
    const deployment = {
      name,
      directory,
      workerName: name,
      workerUrl: `https://${name}.${this.#options.workersSubdomain}.workers.dev`,
      hostname: `${name}.${this.#options.domain}`,
      databaseName: `${name}-data`,
    };
    await this.alchemy("deploy", deployment, oidcClient);
    return deployment;
  }

  async destroy(name: string, directory: string): Promise<void> {
    await this.alchemy("destroy", {
      name,
      directory,
      workerName: name,
      workerUrl: `https://${name}.${this.#options.workersSubdomain}.workers.dev`,
      hostname: `${name}.${this.#options.domain}`,
      databaseName: `${name}-data`,
    });
  }
}

export const deployCloudflare = (
  options: CloudflareDeployerOptions,
  name: string,
  directory: string,
) => attempt(() => new CloudflareDeployer(options).deploy(name, directory), 502);

export const destroyCloudflare = (
  options: CloudflareDeployerOptions,
  name: string,
  directory: string,
) => attempt(() => new CloudflareDeployer(options).destroy(name, directory), 502);
