import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { NewTicketId, TicketId } from "./Ticket.id.ts";

export class TicketAlreadyOpen extends Domain.Rejection(
  "TicketAlreadyOpen",
  { ticketId: TicketId },
  { description: "A ticket with this id has already been opened.", httpApiStatus: 409 },
) {}

export class TicketOpened extends Domain.Event(
  "TicketOpened",
  {
    title: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "A short summary of the problem.",
    }),
    reporter: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "The person reporting the problem.",
    }),
  },
  { description: "A support ticket was opened." },
) {}

export class OpenTicket extends Domain.Command(
  "OpenTicket",
  {
    target: NewTicketId,
    input: {
      title: TicketOpened.fields.title,
      reporter: TicketOpened.fields.reporter,
    },
    events: [TicketOpened],
    rejects: [TicketAlreadyOpen],
  },
  { description: "Open a support ticket, generating its id when --target is omitted." },
) {}
