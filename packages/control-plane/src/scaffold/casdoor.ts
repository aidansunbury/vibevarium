import type * as Effect from "effect/Effect";
import { attempt, ScaffoldError } from "./errors.ts";

/**
 * Per-app OIDC client registration in Casdoor via Dynamic Client Registration
 * (RFC 7591) + registration management (RFC 7592). This replaces the Logto M2M
 * Management-API adapter (logto.ts): Casdoor's DCR endpoint is unauthenticated
 * (gated per-organization by `dcrPolicy: open`), so per-app OIDC clients are
 * created with a single POST — no admin token, no pre-provisioned M2M app.
 *
 * Why Casdoor: DCR covers today's MCP path; Casdoor also supports CIMD, so the
 * same server covers the MCP spec's forward path. See docs/redeployment-plan.md §1.
 */
export interface CasdoorAdminOptions {
  /** Casdoor issuer origin, e.g. `https://auth.vibevarium.com` (no trailing slash). */
  readonly issuer: string;
  /** Organization that dynamically-registered clients land in (default `vibevarium`). */
  readonly organization?: string | undefined;
}

export interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** RFC 7592: needed to update/delete the registration later. */
  readonly registrationAccessToken?: string | undefined;
  /** RFC 7592: the management endpoint for this client (…/api/oauth/register/<id>). */
  readonly registrationClientUri?: string | undefined;
}

/** The DCR endpoint; `organization` selects which org the client is created in. */
const registerUrl = (options: CasdoorAdminOptions) => {
  const base = options.issuer.replace(/\/$/, "");
  const org = options.organization ?? "vibevarium";
  return `${base}/api/oauth/register?organization=${encodeURIComponent(org)}`;
};

/** Shape of an RFC 7591 registration response (subset we care about). */
interface DcrResponse {
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly registration_access_token?: string;
  readonly registration_client_uri?: string;
  readonly error?: string;
  readonly error_description?: string;
}

export const createOidcClient = (
  options: CasdoorAdminOptions,
  input: { readonly name: string; readonly callbackUrl: string; readonly logoutUrl: string },
): Effect.Effect<RegisteredClient, ScaffoldError> =>
  attempt(async (): Promise<RegisteredClient> => {
    const response = await fetch(registerUrl(options), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: input.name,
        redirect_uris: [input.callbackUrl],
        post_logout_redirect_uris: [input.logoutUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        application_type: "web",
      }),
    });
    const body = (await response.json()) as DcrResponse;
    if (body.client_id === undefined || body.client_secret === undefined) {
      throw new ScaffoldError(
        502,
        `Casdoor DCR register failed: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim(),
      );
    }
    return {
      clientId: body.client_id,
      clientSecret: body.client_secret,
      registrationAccessToken: body.registration_access_token,
      registrationClientUri: body.registration_client_uri,
    };
  }, 502);

export const deleteOidcClient = (
  options: CasdoorAdminOptions,
  clientId: string,
  registrationAccessToken?: string,
): Effect.Effect<void, ScaffoldError> =>
  attempt(async () => {
    const base = options.issuer.replace(/\/$/, "");
    // RFC 7592: DELETE /api/oauth/register/<client-id> with the registration
    // access token. If no token is available (e.g. it wasn't persisted), we
    // still attempt the delete — Casdoor may accept it depending on policy.
    await fetch(`${base}/api/oauth/register/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      headers: registrationAccessToken === undefined
        ? {}
        : { authorization: `Bearer ${registrationAccessToken}` },
    });
  }, 502);
