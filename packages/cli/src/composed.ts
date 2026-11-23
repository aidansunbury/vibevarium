import type { Exposable } from "@alchemy.run/domain/Cli";
import { toCli } from "@alchemy.run/domain/Cli";
import { TicketsApi } from "@terrarium/template/TicketsApi.api";
import * as Command from "effect/cli/Command";
import { authCommands, ssoHeaders, ssoProtocolHttp } from "./auth.ts";
import { rpcUrl } from "./config.ts";
import { control } from "./control.ts";
import { cliName } from "./name.ts";

const exposed = [
  "OpenTicket",
  "CloseTicket",
  "TicketById.get",
  "TicketList.get",
] as const satisfies ReadonlyArray<Exposable<typeof TicketsApi>>;

const ticketsUrl = process.env.PLATFORM_TICKETS_URL ?? "http://127.0.0.1:3000";

export const tickets = toCli(TicketsApi, {
  name: "tickets",
  expose: exposed,
  headers: ssoHeaders,
}).pipe(Command.provide(ssoProtocolHttp(rpcUrl(ticketsUrl))));

export const platform = Command.make(cliName).pipe(
  Command.withSubcommands([...authCommands, control, tickets]),
  Command.withDescription("One SSO login for every composed Terrarium app"),
);
