import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { controlPlaneServer } from "./server.ts";

const integerEnv = (name: string, fallback: number) => {
  const value = process.env[name];
  return value === undefined ? fallback : Number.parseInt(value, 10);
};

const server = Layer.effectDiscard(HttpServer.logAddress).pipe(
  Layer.provideMerge(controlPlaneServer({
    port: integerEnv("PORT", 4100),
    databasePath: process.env.DATABASE_PATH,
    discoveryIntervalMs: integerEnv("DISCOVERY_INTERVAL_MS", 30_000),
    discoveryTimeoutMs: integerEnv("DISCOVERY_TIMEOUT_MS", 3_000),
    callTimeoutMs: integerEnv("CALL_TIMEOUT_MS", 3_000),
    discoveryToken: process.env.DISCOVERY_TOKEN,
    scaffold: {
      issuer: process.env.TERRARIUM_ISSUER,
      appsRoot: process.env.TERRARIUM_APPS_ROOT,
      startupTimeoutMs: integerEnv("APP_START_TIMEOUT_MS", 20_000),
    },
  })),
);

NodeRuntime.runMain(Layer.launch(server));
