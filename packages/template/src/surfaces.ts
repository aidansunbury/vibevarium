import * as DomainAi from "@alchemy.run/domain/Ai";
import * as DomainHttp from "@alchemy.run/domain/Http";
import { TicketsApi } from "./TicketsApi.api.ts";

export const exposed = [
  "OpenTicket",
  "CloseTicket",
  "TicketById.get",
  "TicketList.get",
] as const;

export const TicketsHttp = DomainHttp.toHttpApi(TicketsApi, { expose: exposed });
export const TicketsMcp = DomainAi.toMcp(TicketsApi, { expose: exposed });
