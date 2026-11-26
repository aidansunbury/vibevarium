import { randomBytes } from "node:crypto";
import type * as Effect from "effect/Effect";
import { attempt, ScaffoldError } from "./errors.ts";

/**
 * Per-app OIDC client registration in Casdoor via Dynamic Client Registration
 * (RFC 7591) + registration management (RFC 7592). This replaces the Logto M2M
 * Management-API adapter (logto.ts): Casdoor's DCR endpoint is unauthenticated
 * (gated per-organization by `dcrPolicy: open`), so per-app OIDC clients are
 * created with a single POST. Dedicated machine clients use the management API.
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
  readonly registrationAccessToken: string;
}

/** Casdoor's API origin, including when an organization issuer has an `/orgs/<name>` suffix. */
const apiOrigin = (issuer: string) => issuer.replace(/\/$/, "").replace(/\/orgs\/[^/]+$/, "");

/** The DCR endpoint; `organization` selects which org the client is created in. */
const registerUrl = (options: CasdoorAdminOptions) => {
  const base = apiOrigin(options.issuer);
  const org = options.organization ?? "vibevarium";
  return `${base}/api/oauth/register?organization=${encodeURIComponent(org)}`;
};

/** Shape of an RFC 7591 registration response (subset we care about). */
interface DcrResponse {
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly registration_access_token?: string;
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
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
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
    if (!response.ok || !body.client_id || !body.client_secret || !body.registration_access_token) {
      throw new ScaffoldError(
        502,
        `Casdoor DCR register failed: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim(),
      );
    }
    return {
      clientId: body.client_id,
      clientSecret: body.client_secret,
      registrationAccessToken: body.registration_access_token,
    };
  }, 502);

export const deleteOidcClient = (
  options: CasdoorAdminOptions,
  clientId: string,
  registrationAccessToken: string,
): Effect.Effect<void, ScaffoldError> =>
  attempt(async () => {
    const base = apiOrigin(options.issuer);
    // RFC 7592: DELETE /api/oauth/register/<client-id> with the registration
    // access token. Casdoor reports an already-deleted client as invalid_token.
    const response = await fetch(`${base}/api/oauth/register/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${registrationAccessToken}` },
    });
    if (response.status === 204 || response.status === 404) return;
    if (response.status === 401) {
      const body = await response.json() as DcrResponse;
      if (body.error === "invalid_token" && body.error_description === "client not found") return;
    }
    throw new ScaffoldError(502, `Casdoor DCR deletion failed (HTTP ${response.status})`);
  }, 502);

export const m2mApplicationName = (clientId: string) => `vibevarium-m2m-${clientId}`;

export interface CasdoorProvisioner {
  readonly clientId: string;
  readonly clientSecret: string;
}

const applicationRequest = async (
  options: CasdoorAdminOptions,
  provisioner: CasdoorProvisioner,
  action: "add" | "delete",
  application: { readonly name: string; readonly organization: string } & Readonly<Record<string, unknown>>,
) => {
  const url = new URL(`${apiOrigin(options.issuer)}/api/${action}-application`);
  if (action === "delete") url.searchParams.set("id", `admin/${application.name}`);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Basic ${Buffer.from(`${provisioner.clientId}:${provisioner.clientSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(application),
  });
  if (action === "delete" && response.status === 404) return;
  const result = await response.json() as { status?: string };
  if (!response.ok || result.status !== "ok") {
    throw new ScaffoldError(502, `Casdoor ${action}-application failed (HTTP ${response.status})`);
  }
};

export const createM2mClient = (options: CasdoorAdminOptions, provisioner: CasdoorProvisioner) =>
  attempt(async () => {
    const clientId = randomBytes(16).toString("hex");
    const clientSecret = randomBytes(32).toString("hex");
    await applicationRequest(options, provisioner, "add", {
      owner: "admin",
      displayName: m2mApplicationName(clientId),
      clientId,
      clientSecret,
      cert: process.env.CASDOOR_M2M_CERT ?? "",
      grantTypes: ["client_credentials"],
      // Casdoor restricts clients tagged dcr to OAuth endpoints. Ordinary
      // application credentials have organization management permissions.
      tags: ["dcr"],
      tokenFormat: "JWT",
      expireInHours: 1,
      disableSignin: true,
      name: m2mApplicationName(clientId),
      organization: options.organization ?? "vibevarium",
    });
    return { clientId, clientSecret };
  }, 502);

export const deleteM2mClient = (options: CasdoorAdminOptions, provisioner: CasdoorProvisioner, clientId: string) =>
  attempt(() => applicationRequest(options, provisioner, "delete", {
    owner: "admin",
    name: m2mApplicationName(clientId),
    organization: options.organization ?? "vibevarium",
  }), 502);
