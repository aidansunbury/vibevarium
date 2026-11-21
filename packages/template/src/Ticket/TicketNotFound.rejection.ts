import * as Domain from "@alchemy.run/domain";
import { TicketId } from "./Ticket.id.ts";

export class TicketNotFound extends Domain.Rejection(
  "TicketNotFound",
  { ticketId: TicketId },
  { description: "No ticket exists with this id.", httpApiStatus: 404 },
) {}
