import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Ticket } from "./Ticket.aggregate.ts";
import { TicketSummary } from "./TicketById.view.ts";

// The canonical list projection lives in a Domain Durable Object. D1 is also
// provisioned and bound for query/projection storage in the hosting worker.
export class TicketList extends Domain.View(
  "TicketList",
  {
    from: [Ticket],
    key: Schema.Literal("all"),
    keyOf: { Ticket: () => "all" },
    state: Schema.Struct({ tickets: Schema.Array(TicketSummary) }),
    initial: { tickets: [] },
    evolve: {
      TicketOpened: (list, event, { source }) => ({
        tickets: [
          ...list.tickets,
          {
            id: source.id,
            title: event.title,
            reporter: event.reporter,
            status: "open" as const,
          },
        ],
      }),
      TicketClosed: (list, _event, { source }) => ({
        tickets: list.tickets.map((ticket) =>
          ticket.id === source.id ? { ...ticket, status: "closed" as const } : ticket,
        ),
      }),
    },
  },
  { description: "All tickets under the singleton `all` key." },
) {}
