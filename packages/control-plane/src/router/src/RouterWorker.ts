import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const AppWorkers: Record<string, ReturnType<typeof Cloudflare.Worker.lookup>> = {
  "APP_showcase2": Cloudflare.Worker.lookup({ name: "showcase2" }),};

export const RouterDirectory = Cloudflare.KV.Namespace("TerrariumApps", {
  title: "vibevarium-router-apps",
});

const ZoneId = "15d5d22954d28f66f4e141a1668df477";

export default class RouterWorker extends Cloudflare.Worker<RouterWorker>()(
  "RouterWorker",
  {
    name: "vibevarium-router",
    main: import.meta.url,
    env: AppWorkers,
    routes: [
      { zoneId: ZoneId, pattern: "gitprops.com/*" },
  ],  },
  Effect.gen(function*() {
    const apps = yield* Cloudflare.KV.ReadNamespace(yield* RouterDirectory);
    return {
      fetch: Effect.gen(function*() {
        const request = yield* HttpServerRequest;
        const forwardedHost = request.headers["x-forwarded-host"] ?? request.headers["x-original-host"];
        const incoming = new URL(request.url, forwardedHost === undefined ? "https://gitprops.com" : `https://${forwardedHost}`);
        const name = incoming.hostname === "gitprops.com"
          ? ""
          : incoming.hostname.slice(0, -".gitprops.com".length);
        if (name === "registry" || name === "router" || incoming.pathname === "/__registry" || name.startsWith("vibevarium-router.")) {
          const rows = yield* apps.list().pipe(Effect.orDie);
          return HttpServerResponse.jsonUnsafe({ apps: rows.keys.map((row: { name: string }) => row.name) });
        }
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
          return HttpServerResponse.text("Not a Vibevarium app hostname", { status: 404 });
        }
        const origin = yield* apps.get(name).pipe(Effect.orDie);
        if (origin === null) {
          return yield* HttpServerResponse.json({ error: `No Vibevarium app named ${name}` }, { status: 404 });
        }
        const destination = new URL(incoming.pathname + incoming.search, "https://app.gitprops.invalid");
        const headers: Record<string, string> = { ...request.headers, host: incoming.hostname };
        delete headers["content-length"];
        delete headers["cf-connecting-ip"];
        delete headers["cf-ipcountry"];
        delete headers["cf-ray"];
        delete headers["cf-visitor"];
        delete headers["x-forwarded-proto"];
        const forwarded = request.source instanceof Request
          ? new Request(destination, request.source)
          : new Request(destination, { headers });
        const app = Object.hasOwn(AppWorkers, `APP_${name}`)
          ? (yield* Cloudflare.WorkerEnvironment)[`APP_${name}`] as { fetch(request: Request): Promise<Response> }
          : undefined;
        const response = yield* Effect.tryPromise(() =>
          app === undefined ? fetch(forwarded) : app.fetch(forwarded)
        ).pipe(Effect.orDie);
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadNamespaceBinding), Effect.orDie),
) {}
