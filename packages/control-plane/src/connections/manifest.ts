import * as Schema from "effect/Schema";

const LinearViewerSchema = Schema.Struct({
  data: Schema.optional(Schema.Struct({
    viewer: Schema.optional(Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    })),
  })),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) }))),
});

/** Linear's identity is GraphQL; the rest of its OAuth definition is config data. */
export const fetchLinearIdentity = async (accessToken: string): Promise<{ readonly sub: string; readonly label: string }> => {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query: "{ viewer { id name email } }" }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Linear viewer query returned HTTP ${response.status}`);
  const body = await Schema.decodeUnknownPromise(LinearViewerSchema)(await response.json());
  const viewer = body.data?.viewer;
  if (viewer?.id === undefined) {
    throw new Error(`Linear viewer query failed: ${body.errors?.[0]?.message ?? "no viewer in response"}`);
  }
  return { sub: viewer.id, label: viewer.email ?? viewer.name ?? viewer.id };
};
