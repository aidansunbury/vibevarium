import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import GuiWorker from "./src/gui-worker.ts";

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
