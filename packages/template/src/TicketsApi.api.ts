import * as Domain from "@alchemy.run/domain";
import { TicketsModel } from "./Tickets.model.ts";

export class TicketsApi extends Domain.Api(
  "TicketsApi",
  {
    model: TicketsModel,
    commands: ["OpenTicket", "CloseTicket"],
    views: ["TicketById", "TicketList"],
    queries: [],
  },
  { description: "Open, close, and inspect support tickets." },
) {}
