import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CloseTicket, TicketAlreadyClosed, TicketClosed } from "./CloseTicket.command.ts";
import { OpenTicket, TicketAlreadyOpen, TicketOpened } from "./OpenTicket.command.ts";
import { TicketId } from "./Ticket.id.ts";
import { TicketNotFound } from "./TicketNotFound.rejection.ts";

const TicketState = Schema.Union([
  Schema.TaggedStruct("Missing", {}),
  Schema.TaggedStruct("Open", { title: Schema.String, reporter: Schema.String }),
  Schema.TaggedStruct("Closed", { title: Schema.String, reporter: Schema.String }),
]);

export class Ticket extends Domain.Aggregate(
  "Ticket",
  {
    id: TicketId,
    state: TicketState,
    initial: { _tag: "Missing" },
    commands: [OpenTicket, CloseTicket],
    decide: {
      OpenTicket: (ticket, command, { id }) =>
        ticket._tag !== "Missing"
          ? new TicketAlreadyOpen({ ticketId: id })
          : [new TicketOpened({ title: command.title, reporter: command.reporter })],
      CloseTicket: (ticket, _command, { id }) => {
        if (ticket._tag === "Missing") return new TicketNotFound({ ticketId: id });
        if (ticket._tag === "Closed") return new TicketAlreadyClosed({ ticketId: id });
        return [new TicketClosed()];
      },
    },
    evolve: {
      TicketOpened: (_, event) => ({
        _tag: "Open" as const,
        title: event.title,
        reporter: event.reporter,
      }),
      TicketClosed: (ticket) =>
        ticket._tag === "Open"
          ? { _tag: "Closed" as const, title: ticket.title, reporter: ticket.reporter }
          : ticket,
    },
  },
  { description: "One support ticket and its open/closed lifecycle." },
) {}
