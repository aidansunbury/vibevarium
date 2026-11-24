import * as Schema from "effect/Schema";
import type { ProviderManifestEntry } from "./service.ts";

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

/**
 * Provider manifest (data, not per-provider code — the spike's auth-template
 * idea). ONE real provider for v1: GitHub. The OAuth client credentials come
 * from the SecretsProvider by reference — GITHUB_OAUTH_CLIENT_ID / _SECRET in
 * env locally, SM entries in prod (see CONNECTIONS-SPIKE.md for the GitHub
 * OAuth App settings).
 */
export const GITHUB_PROVIDER: ProviderManifestEntry = {
  name: "github",
  displayName: "GitHub",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userinfoUrl: "https://api.github.com/user",
  apiBaseUrl: "https://api.github.com",
  clientIdRef: "GITHUB_OAUTH_CLIENT_ID",
  clientSecretRef: "GITHUB_OAUTH_CLIENT_SECRET",
  defaultScopes: ["read:user", "user:email"],
  responseMode: "query",
};

/**
 * Linear's identity is GraphQL, not a REST userinfo endpoint: POST the GraphQL
 * endpoint with `{ viewer { id name email } }` and read `data.viewer`.
 */
const fetchLinearIdentity = async (accessToken: string): Promise<{ readonly sub: string; readonly label: string }> => {
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

/**
 * Linear (docs/connections.md). Wire quirks vs the generic flow:
 * - scopes are COMMA-separated on the authorize URL (`read,write`); the token
 *   response returns them space-separated, so stored scopes stay normalized.
 * - identity is a GraphQL `viewer` query (see fetchIdentity above).
 * - standard form-encoded token exchange + refresh; PKCE supported.
 * Client credentials come from the SecretsProvider (SM in prod) — same seam
 * as GitHub.
 */
export const LINEAR_PROVIDER: ProviderManifestEntry = {
  name: "linear",
  displayName: "Linear",
  authorizeUrl: "https://linear.app/oauth/authorize",
  tokenUrl: "https://api.linear.app/oauth/token",
  userinfoUrl: "https://api.linear.app/graphql",
  apiBaseUrl: "https://api.linear.app",
  clientIdRef: "LINEAR_OAUTH_CLIENT_ID",
  clientSecretRef: "LINEAR_OAUTH_CLIENT_SECRET",
  defaultScopes: ["read", "write"],
  responseMode: "query",
  scopeSeparator: ",",
  authorizeParams: { actor: "user" },
  fetchIdentity: fetchLinearIdentity,
};
