import * as Domain from "@alchemy.run/domain";
import { TicketId } from "./Ticket.id.ts";
import { TicketNotFound } from "./TicketNotFound.rejection.ts";

export class TicketAlreadyClosed extends Domain.Rejection(
  "TicketAlreadyClosed",
  { ticketId: TicketId },
  { description: "The ticket is already closed.", httpApiStatus: 409 },
) {}

export class TicketClosed extends Domain.Event(
  "TicketClosed",
  {},
  { description: "A support ticket was closed." },
) {}

export class CloseTicket extends Domain.Command(
  "CloseTicket",
  {
    target: TicketId,
    events: [TicketClosed],
    rejects: [TicketNotFound, TicketAlreadyClosed],
  },
  { description: "Close an open support ticket." },
) {}
