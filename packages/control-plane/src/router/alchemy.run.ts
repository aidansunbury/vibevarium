import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import RouterWorker, { RouterDirectory } from "./src/RouterWorker.ts";

const zoneId = "15d5d22954d28f66f4e141a1668df477";
const records = [
  { id: "RouterApexDns", name: "gitprops.com" },
  { id: "RouterWildcardDns", name: "*.gitprops.com" },
] as const;

export default Alchemy.Stack(
  "TerrariumRouter",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function*() {
    const worker = yield* RouterWorker;
    const directory = yield* RouterDirectory;
    for (const record of records) {
      yield* Cloudflare.DNS.Record(record.id, {
        zoneId,
        name: record.name,
        type: "AAAA",
        content: "100::",
        proxied: true,
        comment: "Terrarium router placeholder (Worker is the origin)",
      });
    }
    return {
      workerUrl: worker.url.as<string>(),
      directoryId: directory.namespaceId,
      routes: ["gitprops.com/*", "*.gitprops.com/*"],
    };
  }),
);
