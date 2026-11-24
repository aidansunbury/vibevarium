import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * The control-plane GUI — a static SPA served from a Cloudflare Worker's asset
 * layer at platform.<domain>. The API lives on the box at api.<domain>; the
 * SPA calls it cross-subdomain (same-site → SameSite=Lax session cookie + CORS).
 *
 * Env:
 *   WORKER_NAME        — the Worker name (default vibevarium-control-plane-web)
 *   APP_HOSTNAME       — public hostname (default platform.vibevarium.com)
 *   CLOUDFLARE_ZONE_ID — zone for the hostname (defaults to the vibevarium.com zone)
 */
export class GuiWorker extends Cloudflare.Worker<GuiWorker>()(
  "GuiWorker",
  {
    name: process.env.WORKER_NAME ?? "vibevarium-control-plane-web",
    main: import.meta.url,
    domain: {
      name: process.env.APP_HOSTNAME ?? "platform.vibevarium.com",
      zoneId: process.env.CLOUDFLARE_ZONE_ID ?? "c6ae3b555628f3c6c0fb3883c479dcc4",
    },
    // The built SPA (vite output). Client-side routes fall back to index.html.
    assets: {
      directory: "./dist",
      notFoundHandling: "single-page-application",
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("Not found", { status: 404 })),
    };
  }),
) {}

export default Alchemy.Stack(
  process.env.STACK_NAME ?? "VibevariumControlPlaneWeb",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* GuiWorker;
    return {
      workerName: worker.workerName,
      url: worker.url.as<string>(),
    };
  }),
);
