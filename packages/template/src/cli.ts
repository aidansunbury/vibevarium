#!/usr/bin/env -S node --experimental-strip-types
import * as Domain from "@alchemy.run/domain";
import { toCli } from "@alchemy.run/domain/Cli";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { TicketsApi } from "./TicketsApi.api.ts";
import { exposed } from "./surfaces.ts";

const url = (process.env.TICKETS_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const tickets = toCli(TicketsApi, { name: "tickets", expose: exposed });

Command.run(tickets, { version: "0.0.1" }).pipe(
  Effect.provide(Domain.protocolHttp(`${url}/rpc`)),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
