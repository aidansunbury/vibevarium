import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Predicate from "effect/Predicate";

export const configDirectory =
  process.env.TERRARIUM_CONFIG_DIR ?? join(homedir(), ".config", "terrarium");
export const authFile = join(configDirectory, "auth.json");
export const appsFile = join(configDirectory, "apps.json");

const isMissing = (error: unknown) =>
  Predicate.hasProperty("code")(error) && error.code === "ENOENT";

export const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

export const writeJsonFile = async (path: string, value: unknown) => {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode does not tighten permissions on an existing file.
  await chmod(path, 0o600);
};

export const rpcUrl = (appUrl: string) => `${appUrl.replace(/\/+$/, "")}/rpc`;

/**
 * The control plane base URL the `control` CLI subtree talks to. Defaults to
 * the production platform; override with PLATFORM_CONTROL_PLANE_URL for local
 * development (e.g. http://127.0.0.1:4100).
 */
export const controlPlaneUrl = (
  process.env.PLATFORM_CONTROL_PLANE_URL ?? "https://platform.vibevarium.com"
).replace(/\/+$/, "");
