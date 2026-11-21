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
    state: Cloudflare.state(process.env.CLOUDFLARE_ACCOUNT_ID === undefined
      ? {}
      : { accountId: process.env.CLOUDFLARE_ACCOUNT_ID }),
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
