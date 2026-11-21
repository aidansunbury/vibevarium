import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { runGatewayProof } from "./proof.ts";

describe("meta-MCP gateway", () => {
  it("aggregates two apps, proxies with headers, and isolates a killed app", async () => {
    const report = await Effect.runPromise(Effect.scoped(runGatewayProof));

    expect(report.gatewayToolsList.tools).toHaveLength(10);
    expect(report.callThroughGatewayToA.structuredContent).toMatchObject({ stream: "Ticket/proof-a-1" });
    expect(report.killAppB.registryRow?.status).toBe("down");
    expect(report.killAppB.retainedTools).toHaveLength(4);
    expect(report.killAppB.bCallResult.isError).toBe(true);
    expect(report.killAppB.aCallResultAfterBKilled.structuredContent).toMatchObject({ stream: "Ticket/proof-a-2" });
    expect(report.headerForwarding.observedChildRequest?.headers["x-spike-marker"]).toBe("proof-from-agent");
  }, 30_000);
});
