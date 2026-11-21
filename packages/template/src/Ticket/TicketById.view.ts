import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Ticket } from "./Ticket.aggregate.ts";
import { TicketId } from "./Ticket.id.ts";

export const TicketSummary = Schema.Struct({
  id: TicketId,
  title: Schema.String,
  reporter: Schema.String,
  status: Schema.Literals(["open", "closed"]),
});

export class TicketById extends Domain.View(
  "TicketById",
  {
    from: [Ticket],
    key: Ticket,
    state: TicketSummary,
    initial: { id: TicketId.make(""), title: "", reporter: "", status: "open" },
    evolve: {
      TicketOpened: (_, event, { source }) => ({
        id: source.id,
        title: event.title,
        reporter: event.reporter,
        status: "open" as const,
      }),
      TicketClosed: (ticket, _event, { source }) => ({
        ...ticket,
        id: source.id,
        status: "closed" as const,
      }),
    },
  },
  { description: "The current title, reporter, and status of one ticket." },
) {}
