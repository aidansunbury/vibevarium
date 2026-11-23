import type * as Effect from "effect/Effect";
import { attempt, ScaffoldError } from "./errors.ts";

/**
 * Per-app OIDC client registration in Logto. Scaffold calls `createOidcClient`
 * at deploy time (Traditional web client, redirect <name>.<domain>/auth/callback)
 * and `deleteOidcClient` on app teardown. The client secret goes into the app's
 * worker env (TERRARIUM_CLIENT_*), so the app can run its auth-code flow.
 */
export interface LogtoAdminOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly managementResource: string;
}

export interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

const mintAdminToken = async (options: LogtoAdminOptions): Promise<string> => {
  const response = await fetch(`${options.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      resource: options.managementResource,
      scope: "all",
    }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (body.access_token === undefined) {
    throw new ScaffoldError(502, `Logto admin token mint failed: ${body.error ?? response.status}`);
  }
  return body.access_token;
};

/** Logto's Management API lives at the issuer root, not under /oidc. */
const managementBase = (issuer: string) => issuer.replace(/\/oidc\/?$/, "");

export const createOidcClient = (
  options: LogtoAdminOptions,
  input: { readonly name: string; readonly callbackUrl: string; readonly logoutUrl: string },
): Effect.Effect<RegisteredClient, ScaffoldError> =>
  attempt(async (): Promise<RegisteredClient> => {
    const adminToken = await mintAdminToken(options);
    const headers = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
    const base = managementBase(options.issuer);

    const created = await fetch(`${base}/api/applications`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: input.name,
        type: "Traditional",
        oidcClientMetadata: {
          redirectUris: [input.callbackUrl],
          postLogoutRedirectUris: [input.logoutUrl],
        },
      }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { id?: string; error?: string } }));
    if (created.body.id === undefined) {
      throw new ScaffoldError(502, `Logto app create failed: ${created.body.error ?? created.status}`);
    }

    const secret = await fetch(`${base}/api/applications/${created.body.id}/secrets`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "terrarium" }),
    }).then(async (r) => (await r.json()) as { value?: string; error?: string });
    if (secret.value === undefined) {
      throw new ScaffoldError(502, `Logto secret create failed: ${secret.error ?? "unknown"}`);
    }

    return { clientId: created.body.id, clientSecret: secret.value };
  }, 502);

export const deleteOidcClient = (
  options: LogtoAdminOptions,
  clientId: string,
): Effect.Effect<void, ScaffoldError> =>
  attempt(async () => {
    const adminToken = await mintAdminToken(options);
    await fetch(`${managementBase(options.issuer)}/api/applications/${clientId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
  }, 502);
