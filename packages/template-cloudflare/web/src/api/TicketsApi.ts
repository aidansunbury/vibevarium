/**
 * The HTTP surface of the Tickets domain API, vendored as a typed `HttpApi`
 * declaration so this SPA stays self-contained — a generated app has no
 * `workspace:*` deps. It mirrors, one endpoint per exposed call, what
 * `DomainHttp.toHttpApi(TicketsApi, { expose })` builds from the domain source
 * (`../src/TicketsApi.api.ts` + `../src/Ticket/*`):
 *
 * - a command `X` is `POST /X` with the RPC payload as the JSON body;
 * - a view read `V.get` is `GET /V/:key` with an optional
 *   `?stream=&version=` read-your-write query (from the RPC's `atLeast`).
 *
 * The schemas are the RPC's own (the HTTP wire IS the RPC wire,
 * `packages/domain/Http.ts`), so request/response types match the Worker's
 * exactly. `client.ts` feeds this to `effect/http-api/HttpApiClient` to get
 * the typed browser client. If the domain surface changes, mirror it here —
 * the OpenAPI doc at /openapi.json is the diff source.
 */
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

// --- wire schemas (mirrored from ../src/Ticket/*) ----------------------------

export const TicketSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  reporter: Schema.String,
  status: Schema.Literals(["open", "closed"]),
});
export type TicketSummary = typeof TicketSummary.Type;

export class CommandReceipt extends Schema.Class<CommandReceipt>("CommandReceipt")({
  reply: Schema.Null,
  stream: Schema.String,
  version: Schema.Number,
}) {}

export const TicketListView = Schema.Struct({ tickets: Schema.Array(TicketSummary) });
export type TicketListView = typeof TicketListView.Type;

export class TicketNotFound extends Schema.TaggedError<TicketNotFound>()("TicketNotFound", {
  ticketId: Schema.String,
}) {}

export class TicketAlreadyOpen extends Schema.TaggedError<TicketAlreadyOpen>()("TicketAlreadyOpen", {
  ticketId: Schema.String,
}) {}

export class TicketAlreadyClosed extends Schema.TaggedError<TicketAlreadyClosed>()("TicketAlreadyClosed", {
  ticketId: Schema.String,
}) {}

/** The read-your-write query of a `.get`: wait for a write, as its receipt. */
const AtLeastQuery = Schema.Struct({
  stream: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Number),
});

// --- the HttpApi (mirrors DomainHttp.toHttpApi(TicketsApi, { expose })) -------

export const TicketsHttp = HttpApi.make("TicketsApi").add(
  HttpApiGroup.make("TicketsApi", { topLevel: true })
    .add(
      HttpApiEndpoint.post("OpenTicket", "/OpenTicket", {
        payload: Schema.Struct({
          target: Schema.optional(Schema.String),
          input: Schema.Struct({
            title: Schema.String.check(Schema.isMinLength(1)),
            reporter: Schema.String.check(Schema.isMinLength(1)),
          }),
        }),
        success: CommandReceipt,
        error: [TicketAlreadyOpen],
      }),
    )
    .add(
      HttpApiEndpoint.post("CloseTicket", "/CloseTicket", {
        payload: Schema.Struct({ target: Schema.String, input: Schema.Struct({}) }),
        success: CommandReceipt,
        error: [TicketNotFound, TicketAlreadyClosed],
      }),
    )
    .add(
      HttpApiEndpoint.get("TicketById.get", "/TicketById/:key", {
        params: { key: Schema.String },
        query: AtLeastQuery,
        success: Schema.NullOr(TicketSummary),
        error: [TicketNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.get("TicketList.get", "/TicketList/:key", {
        params: { key: Schema.String },
        query: AtLeastQuery,
        success: Schema.NullOr(TicketListView),
      }),
    ),
);
