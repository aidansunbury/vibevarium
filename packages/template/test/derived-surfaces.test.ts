import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo.ts";
import { TicketsModel } from "../src/Tickets.model.ts";

describe("TicketsApi derived surfaces", () => {
  it("has a valid model", () => {
    expect(Domain.verify(TicketsModel)).toEqual([]);
  });

  it("serves HTTP + OpenAPI, MCP, and the CLI from one Api", async () => {
    const report = await Effect.runPromise(Effect.scoped(runDemo));

    expect(report.http.byId).toMatchObject({ id: "http-1", status: "closed" });
    expect(report.http.list).toMatchObject({
      tickets: [{ id: "http-1", title: "Printer is offline", status: "closed" }],
    });
    expect(Object.keys(report.openApi.paths)).toEqual(
      expect.arrayContaining(["/OpenTicket", "/CloseTicket", "/TicketById/{key}", "/TicketList/{key}"]),
    );

    expect(report.mcp.tools.map((tool) => tool.name)).toEqual([
      "TicketsApi_OpenTicket_send",
      "TicketsApi_CloseTicket_send",
      "TicketsApi_TicketById_get",
      "TicketsApi_TicketList_get",
    ]);
    expect(report.mcp.opened).toMatchObject({
      isError: false,
      structuredContent: { stream: "Ticket/mcp-1", version: 1 },
    });
    expect(report.mcp.byId).toMatchObject({ isError: false });

    const opened = JSON.parse(report.cli.opened);
    expect(opened.stream).toMatch(/^Ticket\/.+/);
    expect(JSON.parse(report.cli.byId)).toMatchObject({
      title: "VPN access is missing",
      reporter: "carol",
      status: "closed",
    });
    expect(report.cli.help).toContain("open-ticket");
    expect(report.cli.help).toContain("Open, close, and inspect support tickets.");
  }, 30_000);
});
