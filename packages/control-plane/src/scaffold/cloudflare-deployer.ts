import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { attempt, ScaffoldError } from "./errors.ts";
import { r2BucketName } from "./template.ts";

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
  readonly r2BucketName?: string;
}

interface AppIdentity {
  readonly oidc: { readonly clientId: string; readonly clientSecret: string };
  readonly m2m: { readonly clientId: string; readonly clientSecret: string };
  readonly issuer: string;
  readonly platformAudience: string;
}

export class CloudflareDeployer {
  readonly #options: CloudflareDeployerOptions;

  constructor(options: CloudflareDeployerOptions) {
    this.#options = options;
  }

  private env(name: string, identity?: AppIdentity, features: ReadonlyArray<string> = []) {
    return {
      ...process.env,
      CASDOOR_PROVISIONER_CLIENT_ID: undefined,
      CASDOOR_PROVISIONER_CLIENT_SECRET: undefined,
      // The control plane runs inside an Alchemy-deployed ECS service, which
      // injects ALCHEMY_PHASE=runtime and ALCHEMY_STACK_NAME. Child alchemy
      // CLI invocations must run in plan phase so Worker bindings receive
      // their deploy-time planServices (including WorkerEnvironment).
      ALCHEMY_PHASE: "plan",
      ALCHEMY_STACK_NAME: undefined,
      // Containers have no interactive alchemy profile; CI=1 makes alchemy
      // resolve credentials from environment variables (CLOUDFLARE_API_TOKEN).
      CI: "1",
      ALCHEMY_HOME: this.#options.alchemyHome,
      CLOUDFLARE_ACCOUNT_ID: this.#options.accountId,
      STACK_NAME: `vibevarium-${name}`,
      WORKER_NAME: name,
      D1_DATABASE_NAME: `${name}-data`,
      APP_HOSTNAME: `${name}.${this.#options.domain}`,
      R2_BUCKET_NAME: features.includes("r2") ? r2BucketName(name) : undefined,
      // Option B′: the app's own audience + the platform audience it also accepts.
      TERRARIUM_AUDIENCE: `${name}.${this.#options.domain}`,
      TERRARIUM_PLATFORM_AUDIENCE: `https://mcp.${this.#options.domain}`,
      ...(identity === undefined ? {} : {
        TERRARIUM_ISSUER: identity.issuer,
        TERRARIUM_PLATFORM_AUDIENCE: identity.platformAudience,
        TERRARIUM_CLIENT_ID: identity.oidc.clientId,
        TERRARIUM_CLIENT_SECRET: identity.oidc.clientSecret,
        TERRARIUM_M2M_CLIENT_ID: identity.m2m.clientId,
        TERRARIUM_M2M_CLIENT_SECRET: identity.m2m.clientSecret,
      }),
    };
  }

  private async alchemy(
    command: "deploy" | "destroy",
    deployment: CloudflareDeployment,
    identity?: AppIdentity,
    features: ReadonlyArray<string> = [],
  ) {
    if (this.#options.packageManager === "pnpm") {
      await execFileAsync("pnpm", ["install", "--frozen-lockfile=false"], {
        cwd: deployment.directory,
        env: this.env(deployment.name, identity, features),
        timeout: 3 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } else {
      const template = createRequire(import.meta.url).resolve("vibevarium-tickets-cloudflare/package.json");
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
          env: this.env(deployment.name, identity, features),
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
    identity?: AppIdentity,
    features: ReadonlyArray<string> = [],
  ): Promise<CloudflareDeployment> {
    const deployment = {
      name,
      directory,
      workerName: name,
      workerUrl: `https://${name}.${this.#options.workersSubdomain}.workers.dev`,
      hostname: `${name}.${this.#options.domain}`,
      databaseName: `${name}-data`,
      ...(features.includes("r2") ? { r2BucketName: r2BucketName(name) } : {}),
    };
    await this.alchemy("deploy", deployment, identity, features);
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
  features: ReadonlyArray<string> = [],
) => attempt(() => new CloudflareDeployer(options).deploy(name, directory, undefined, features), 502);

export const destroyCloudflare = (
  options: CloudflareDeployerOptions,
  name: string,
  directory: string,
) => attempt(() => new CloudflareDeployer(options).destroy(name, directory), 502);
