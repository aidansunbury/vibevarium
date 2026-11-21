import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const TicketId = Schema.String.pipe(
  Schema.brand("TicketId"),
  Schema.annotate({ description: "The unique ticket id." }),
);

/** OpenTicket generates an id when its caller does not supply one. */
export const NewTicketId = TicketId.pipe(
  Schema.withDecodingDefaultKey(Effect.sync(() => TicketId.make(globalThis.crypto.randomUUID()))),
  Schema.annotate({ description: "The ticket id. Omit it to generate a UUID." }),
);
