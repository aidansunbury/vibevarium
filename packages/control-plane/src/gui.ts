import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

export interface GuiOptions {
  /** Directory containing the built SPA (vite build output). Unset disables static serving. */
  readonly staticDir?: string | undefined;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Static SPA serving: files from the vite build output, with an index.html
 * fallback for client-side routes. Mounted last so API routes win.
 */
export const guiRoutes = (options: GuiOptions) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      if (options.staticDir === undefined) return;
      const root = normalize(options.staticDir);
      if (!existsSync(root)) return;

      const indexPath = join(root, "index.html");
      const servePath = (path: string) =>
        Effect.gen(function*() {
          const cleaned = normalize(path).replace(/^(\.\.[/\\])+/, "");
          const filePath = join(root, cleaned);
          if (!filePath.startsWith(root)) {
            return HttpServerResponse.text("forbidden", { status: 403 });
          }
          const target = existsSync(filePath) && !filePath.endsWith("/") ? filePath : indexPath;
          if (!existsSync(target)) {
            return HttpServerResponse.text(
              "GUI is not built. Run `pnpm --filter @vibevarium/control-plane gui:build` or `gui:dev`.",
              { status: 404 },
            );
          }
          const body = yield* Effect.promise(() => readFile(target));
          return HttpServerResponse.uint8Array(new Uint8Array(body), {
            status: 200,
            headers: { "content-type": contentTypes[extname(target)] ?? "application/octet-stream" },
          });
        });

      // The SPA itself is public HTML/JS; the API calls it makes are the gated
      // part (the SPA's login button mints a dev token that every API call sends).
      yield* router.add("GET", "/", servePath("index.html"));
      yield* router.add("GET", "/*", Effect.gen(function*() {
        const params = yield* HttpRouter.params;
        return yield* servePath(params["*"] ?? "index.html");
      }));
    })
  );
