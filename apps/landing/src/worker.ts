import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * The vibevarium.com landing page — a static site served from a Cloudflare
 * Worker's asset layer at the apex + www hostnames. No build step: the site
 * is a single hand-authored HTML page (see ../public/index.html), so there is
 * nothing to bundle; the worker exists only to carry the assets + domain.
 *
 * Env:
 *   APP_HOSTNAME       — public hostname (default vibevarium.com)
 *   CLOUDFLARE_ZONE_ID — zone for the hostname (defaults to the vibevarium.com zone)
 */
export default class LandingWorker extends Cloudflare.Worker<LandingWorker>()(
  "LandingWorker",
  {
    name: process.env.WORKER_NAME ?? "vibevarium-landing",
    main: import.meta.url,
    domain: {
      name: process.env.APP_HOSTNAME ?? "vibevarium.com",
      zoneId: process.env.CLOUDFLARE_ZONE_ID ?? "c6ae3b555628f3c6c0fb3883c479dcc4",
    },
    assets: {
      directory: "./public",
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("Not found", { status: 404 })),
    };
  }),
) {}
