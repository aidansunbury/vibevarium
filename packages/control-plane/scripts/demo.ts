import * as Effect from "effect/Effect";
import { runGatewayProof } from "../src/proof.ts";

Effect.runPromise(Effect.scoped(runGatewayProof)).then(
  (report) => console.log(JSON.stringify(report, null, 2)),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
