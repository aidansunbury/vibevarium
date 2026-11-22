#!/usr/bin/env -S node --experimental-strip-types
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { dynamicPlatform } from "./apps.ts";
import { cliVersion } from "./version.ts";

Effect.gen(function* () {
  const platform = yield* dynamicPlatform;
  yield* Command.run(platform, { version: cliVersion });
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
