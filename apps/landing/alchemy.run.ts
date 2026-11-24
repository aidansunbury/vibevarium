import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import LandingWorker from "./src/worker.ts";

export default Alchemy.Stack(
  process.env.STACK_NAME ?? "VibevariumLanding",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* LandingWorker;
    return {
      workerName: worker.workerName,
      url: worker.url.as<string>(),
    };
  }),
);
