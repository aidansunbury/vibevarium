import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { attempt, ScaffoldError } from "./errors.ts";

export interface RouterDirectoryOptions {
  readonly accountId: string;
  readonly zoneId: string;
  readonly namespaceId: string;
}

/** The router reads Cloudflare KV, never a localhost registry callback. */
export class RouterDirectory {
  readonly #options: RouterDirectoryOptions;
  readonly #token: Promise<string>;

  constructor(options: RouterDirectoryOptions) {
    this.#options = options;
    this.#token = this.loadToken();
  }

  private async loadToken(): Promise<string> {
    if (process.env.CLOUDFLARE_API_TOKEN !== undefined) return process.env.CLOUDFLARE_API_TOKEN;
    const alchemyHome = process.env.ALCHEMY_HOME;
    if (alchemyHome === undefined) {
      throw new ScaffoldError(503, "Set ALCHEMY_HOME or CLOUDFLARE_API_TOKEN for router registry writes");
    }
    const document = JSON.parse(await readFile(join(alchemyHome, "profiles/default/cloudflare.json"), "utf8")) as {
      values?: { access?: string };
    };
    if (typeof document.values?.access !== "string") {
      throw new ScaffoldError(503, "The Alchemy Cloudflare profile has no OAuth access token");
    }
    return document.values.access;
  }

  private async request(method: "PUT" | "DELETE", name: string, workerUrl?: string): Promise<void> {
    const token = await this.#token;
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.#options.accountId}/storage/kv/namespaces/${this.#options.namespaceId}/values/${name}`;
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === "PUT" ? { "content-type": "text/plain" } : {}),
      },
      ...(workerUrl === undefined ? {} : { body: workerUrl }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ScaffoldError(502, `Cloudflare KV ${method} ${name} failed (${response.status}): ${text}`);
    }
  }

  async put(name: string, workerUrl: string): Promise<void> {
    await Effect.runPromise(attempt(() => this.request("PUT", name, workerUrl), 502));
  }

  async delete(name: string): Promise<void> {
    await Effect.runPromise(attempt(() => this.request("DELETE", name), 502));
  }
}
