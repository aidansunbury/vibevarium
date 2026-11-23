import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import TicketsWorker, { TicketsDatabase } from "./src/TicketsWorker.ts";

export default Alchemy.Stack(
  process.env.STACK_NAME ?? "TerrariumTicketsCloudflare",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
    // Local file state: per-app stacks keep their state with the deployment
    // (in the app dir / control-plane data volume), not an account-pinned R2
    // store — so app deploys need only Workers/D1 perms, not account R2.
    state: Alchemy.localState(),
  },
  Effect.gen(function*() {
    const worker = yield* TicketsWorker;
    const database = yield* TicketsDatabase;
    return {
      workerName: worker.workerName,
      url: worker.url.as<string>(),
      databaseId: database.databaseId,
      databaseName: database.databaseName,
    };
  }),
);
