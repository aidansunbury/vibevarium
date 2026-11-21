import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { ticketsServer } from "./server.ts";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const ServerWithAddressLog = Layer.effectDiscard(HttpServer.logAddress).pipe(
  Layer.provideMerge(ticketsServer(port)),
);

NodeRuntime.runMain(Layer.launch(ServerWithAddressLog));
