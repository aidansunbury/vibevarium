import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { ScaffoldError } from "./errors.ts";

const delay = promisify(setTimeout);
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

export interface RunningApp {
  readonly name: string;
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly logPath: string;
  readonly repoDirectory: string;
}

export interface SpawnedApp extends RunningApp {
  readonly child: ChildProcess;
}

export const allocatePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate an app port")));
        return;
      }
      server.close((cause) => cause ? reject(cause) : resolve(address.port));
    });
  });

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

const waitForExit = (child: ChildProcess) => {
  if (hasExited(child)) return Promise.resolve();
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
};

const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined || hasExited(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process exited between the status check and signal.
    }
  }
};

export class AppProcesses {
  readonly #running = new Map<string, SpawnedApp>();

  start(name: string, repoDirectory: string, port: number, env: NodeJS.ProcessEnv): SpawnedApp {
    if (this.#running.has(name)) {
      throw new ScaffoldError(409, `A child process is already tracked for ${name}`);
    }
    const logPath = join(repoDirectory, "app.log");
    const log = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [tsxCli, join(repoDirectory, "src/main.ts")], {
        cwd: repoDirectory,
        env,
        detached: true,
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    if (child.pid === undefined) {
      throw new ScaffoldError(500, `Could not start ${name}`);
    }
    // A hard control-plane kill must not take the independent app down with it.
    child.unref();
    child.on("error", () => {
      // waitForHealth observes the failed process and reports app.log.
    });
    const running = {
      name,
      pid: child.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      logPath,
      repoDirectory,
      child,
    };
    this.#running.set(name, running);
    return running;
  }

  async writePidFile(app: RunningApp) {
    await writeFile(join(app.repoDirectory, "app.pid"), `${app.pid}\n`, "utf8");
  }

  async stop(name: string) {
    const app = this.#running.get(name);
    if (app === undefined) return;
    this.#running.delete(name);
    const exited = waitForExit(app.child);
    killGroup(app.child, "SIGTERM");
    await Promise.race([exited, delay(3_000)]);
    if (!hasExited(app.child)) {
      killGroup(app.child, "SIGKILL");
      await waitForExit(app.child);
    }
  }

  async stopAll() {
    await Promise.allSettled([...this.#running.keys()].map((name) => this.stop(name)));
  }
}

export const waitForHealth = async (app: SpawnedApp, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (hasExited(app.child)) {
      const log = await readFile(app.logPath, "utf8").catch(() => "");
      throw new ScaffoldError(
        502,
        `${app.name} exited before becoming healthy (${app.child.exitCode ?? app.child.signalCode}).\n${log.slice(-4_000)}`,
      );
    }
    try {
      const response = await fetch(`${app.url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    await delay(100);
  }
  const log = await readFile(app.logPath, "utf8").catch(() => "");
  throw new ScaffoldError(
    502,
    `${app.name} did not become healthy within ${timeoutMs}ms: ${lastError}.\n${log.slice(-4_000)}`,
  );
};
