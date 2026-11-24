import { createHash, randomBytes } from "node:crypto";
import * as Schema from "effect/Schema";
import type { OAuthProviderRow, OAuthSessionRow } from "../store/schema.ts";

// Ported from the proven spike (packages/connections/src/oauth.ts): real PKCE,
// real authorization-code exchange, real refresh-token rotation.

export const OAUTH_SESSION_TTL_MS = 15 * 60_000;
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
});

const TokenErrorSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const UserInfoSchema = Schema.Struct({
  sub: Schema.String,
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  // GitHub's /user is not OIDC-shaped: id + login instead of sub.
  id: Schema.optional(Schema.Number),
  login: Schema.optional(Schema.String),
});

export interface ProviderTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly grantedScopes: string;
}

export class OAuthTokenError extends Error {
  readonly status: number;
  readonly oauthError: string | undefined;

  constructor(status: number, oauthError: string | undefined) {
    super(`Provider token endpoint returned HTTP ${status}${oauthError ? ` (${oauthError})` : ""}`);
    this.name = "OAuthTokenError";
    this.status = status;
    this.oauthError = oauthError;
  }
}

export const createOAuthState = () => randomBytes(32).toString("base64url");
export const createPkceVerifier = () => randomBytes(48).toString("base64url");
export const createPkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export const buildAuthorizationUrl = (input: {
  readonly provider: OAuthProviderRow;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes?: string | undefined;
}) => {
  const url = new URL(input.provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes ?? input.provider.defaultScopes);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // GitHub's authorize endpoint 404s on unknown params; only send response_mode
  // when the provider actually wants form_post.
  if (input.provider.responseMode !== "query") {
    url.searchParams.set("response_mode", input.provider.responseMode);
  }
  return url.toString();
};

const decodeTokenResponse = Schema.decodeUnknownPromise(TokenResponseSchema);
const decodeTokenError = Schema.decodeUnknownSync(TokenErrorSchema);
const decodeUserInfo = Schema.decodeUnknownPromise(UserInfoSchema);

const requestToken = async (
  provider: OAuthProviderRow,
  clientId: string,
  clientSecret: string,
  form: URLSearchParams,
): Promise<ProviderTokenSet> => {
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    let oauthError: string | undefined;
    try {
      oauthError = decodeTokenError(body).error;
    } catch {
      oauthError = undefined;
    }
    throw new OAuthTokenError(response.status, oauthError);
  }
  const token = await decodeTokenResponse(await response.json());
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    tokenType: token.token_type ?? "Bearer",
    expiresAt: token.expires_in === undefined ? null : Date.now() + token.expires_in * 1000,
    grantedScopes: token.scope ?? "",
  };
};

export const exchangeAuthorizationCode = async (
  provider: OAuthProviderRow,
  clientId: string,
  clientSecret: string,
  session: OAuthSessionRow,
  code: string,
): Promise<ProviderTokenSet> => {
  const token = await requestToken(provider, clientId, clientSecret, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: session.redirectUri,
    code_verifier: session.pkceVerifier,
  }));
  return {
    ...token,
    grantedScopes: token.grantedScopes || session.requestedScopes,
  };
};

export const refreshProviderToken = async (
  provider: OAuthProviderRow,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  previousScopes: string,
): Promise<ProviderTokenSet> => {
  const token = await requestToken(provider, clientId, clientSecret, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }));
  return {
    ...token,
    // Rotation: providers that rotate return a new refresh token; those that
    // don't keep the presented one.
    refreshToken: token.refreshToken ?? refreshToken,
    grantedScopes: token.grantedScopes || previousScopes,
  };
};

export const fetchProviderIdentity = async (
  provider: OAuthProviderRow,
  accessToken: string,
): Promise<{ readonly sub: string; readonly label: string }> => {
  const response = await fetch(provider.userinfoUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      // GitHub's API requires a UA header.
      "user-agent": "vibevarium-control-plane",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Provider userinfo returned HTTP ${response.status}`);
  const identity = await decodeUserInfo(await response.json());
  const sub = identity.sub ?? (identity.id !== undefined ? String(identity.id) : undefined);
  if (sub === undefined) throw new Error("Provider userinfo has no subject");
  return {
    sub,
    label: identity.email ?? identity.name ?? identity.login ?? sub,
  };
};

export const shouldRefreshToken = (expiresAt: number | null, refreshSkewMs = DEFAULT_REFRESH_SKEW_MS) =>
  expiresAt !== null && expiresAt - Date.now() <= refreshSkewMs;
