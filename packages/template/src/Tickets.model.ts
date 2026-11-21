import * as Domain from "@alchemy.run/domain";
import { Ticket } from "./Ticket/Ticket.aggregate.ts";
import { TicketById } from "./Ticket/TicketById.view.ts";
import { TicketList } from "./Ticket/TicketList.view.ts";

export class TicketsModel extends Domain.Model(
  "TicketsModel",
  {
    aggregates: [Ticket],
    views: [TicketById, TicketList],
    queries: [],
  },
  { description: "A tiny support-ticket tracker hosted in memory." },
) {}
