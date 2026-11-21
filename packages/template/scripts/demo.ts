import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { runDemo } from "../src/demo.ts";

NodeRuntime.runMain(
  Effect.scoped(runDemo).pipe(
    Effect.tap((report) => Effect.sync(() => console.log(JSON.stringify(report, null, 2)))),
  ),
);
