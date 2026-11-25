import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import { authFile, readJsonFile, writeJsonFile } from "./config.ts";

// ---------------------------------------------------------------------------
// OIDC client configuration (Logto). The CLI is a native/public application:
// no client secret, PKCE only. Defaults are the live tenant; overridable by env.
// ---------------------------------------------------------------------------
const ISSUER = (process.env.PLATFORM_OIDC_ISSUER ?? "https://auth.vibevarium.com/oidc").replace(/\/+$/, "");
const CLIENT_ID = process.env.LOGTO_CLI_APP_ID ?? "a4mo5zbso2lrb6nipf7hj";
/** RFC 8707 resource indicator: keeps the access token audience-restricted. */
const RESOURCE = process.env.PLATFORM_OIDC_AUDIENCE ?? "https://api.vibevarium.com/mcp";
const LOOPBACK_PORT = Number(process.env.TERRARIUM_CLI_CALLBACK_PORT ?? 8919);
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
// offline_access → refresh token; the api.vibevarium.com/mcp API scopes are granted
// against the RFC 8707 resource indicator (and become the access token's scope).
const SCOPES = "openid profile offline_access member admin apps:read apps:write";

const CachedSession = Schema.Struct({
  version: Schema.Literal(2),
  accessToken: Schema.String,
  tokenType: Schema.String,
  issuer: Schema.String,
  audience: Schema.String,
  subject: Schema.String,
  name: Schema.String,
  expiresAt: Schema.Number,
  refreshToken: Schema.optional(Schema.String),
  idToken: Schema.optional(Schema.String),
});

type CachedSession = typeof CachedSession.Type;

const userError = (message: string, cause: unknown = message) =>
  new CliError.UserError({ cause, userMessage: message });

const decodeSession = Schema.decodeUnknownSync(CachedSession);

const loadSession = async (): Promise<CachedSession> => {
  let value: unknown;
  try {
    value = await readJsonFile(authFile);
    if (value === undefined) {
      throw new Error("No cached SSO session; run platform login.");
    }
    return decodeSession(value);
  } catch (error) {
    if (error instanceof Error && error.message.includes("run platform login")) throw error;
    throw new Error("Cached SSO session is unreadable; run platform login.", { cause: error });
  }
};

const writeSession = async (session: CachedSession) => {
  await writeJsonFile(authFile, session);
};

// ---------------------------------------------------------------------------
// PKCE + OIDC discovery helpers
// ---------------------------------------------------------------------------
const base64url = (buffer: Buffer) => buffer.toString("base64url");

export const pkcePair = () => {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

const discoveryUrl = `${ISSUER}/.well-known/openid-configuration`;

interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
}

const fetchDiscovery = async (): Promise<Discovery> => {
  const response = await fetch(discoveryUrl);
  if (!response.ok) throw new Error(`OIDC discovery failed: HTTP ${response.status} from ${discoveryUrl}`);
  const body = (await response.json()) as Discovery;
  return body;
};

/** Decode the payload of a JWT without verifying (the ID token came straight
 * from the issuer's token endpoint over TLS; full verification happens on the
 * resource server / control plane side). */
const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Token exchange / refresh against the token endpoint
// ---------------------------------------------------------------------------
interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string;
}

const tokenRequest = async (params: Record<string, string>): Promise<TokenResponse> => {
  const { token_endpoint } = await fetchDiscovery();
  const body = new URLSearchParams(params);
  const response = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!response.ok) {
    throw new Error(`Token endpoint returned HTTP ${response.status}: ${json.error_description ?? json.error ?? "unknown"}`);
  }
  return json;
};

const sessionFromTokens = (
  tokens: TokenResponse,
  previous?: { refreshToken?: string | undefined; idToken?: string | undefined },
): CachedSession => {
  const idToken = tokens.id_token ?? previous?.idToken;
  if (idToken === undefined) throw new Error("Token response did not include an id_token");
  const claims = decodeJwtPayload(idToken);
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("ID token has no sub claim");
  const subject = claims.sub;
  const name =
    (claims.name as string | undefined) ??
    (claims.preferred_username as string | undefined) ??
    (claims.username as string | undefined) ??
    subject;
  return {
    version: 2,
    accessToken: tokens.access_token,
    tokenType: tokens.token_type,
    issuer: ISSUER,
    audience: RESOURCE,
    subject,
    name,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    idToken,
  };
};

// ---------------------------------------------------------------------------
// Live flow: loopback-redirect authorization code + PKCE
// ---------------------------------------------------------------------------
const buildAuthorizeUrl = (challenge: string, state: string, authorizationEndpoint: string) => {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("resource", RESOURCE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // First-party apps auto-consent; asking for consent explicitly is what makes
  // Logto grant offline_access (the refresh token) alongside the API scopes.
  url.searchParams.set("prompt", "consent");
  return url;
};

const openBrowser = (url: string) => {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  // Fire and forget — if no browser is available the user copies the URL.
  void import("node:child_process").then(({ spawn }) => {
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.unref();
  });
};

const waitForCallback = (state: string): Promise<{ code: string }> =>
  new Promise((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${LOOPBACK_PORT}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error !== null) {
        response.writeHead(400, { "content-type": "text/html" }).end(
          "<p>Sign-in failed. You can close this tab and retry <code>platform login</code>.</p>",
        );
        server.close();
        reject(new Error(`${error}: ${errorDescription ?? ""}`));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400).end("state mismatch");
        server.close();
        reject(new Error("Callback state mismatch — possible CSRF; retry platform login."));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null) {
        response.writeHead(400).end("missing code");
        server.close();
        reject(new Error("Callback had no authorization code"));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(
        "<p>Signed in to Vibevarium. You can close this tab and return to the terminal.</p>",
      );
      server.close();
      resolve({ code });
    });
    server.on("error", reject);
    server.listen(LOOPBACK_PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error(`Timed out waiting for the sign-in callback on ${REDIRECT_URI}`));
    }, 5 * 60 * 1000);
  });

const liveLogin = async (): Promise<CachedSession> => {
  const { authorization_endpoint } = await fetchDiscovery();
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const authorizeUrl = buildAuthorizeUrl(challenge, state, authorization_endpoint);

  const callback = waitForCallback(state);
  openBrowser(authorizeUrl.toString());
  process.stderr.write(
    `\nOpening your browser to sign in. If it does not open, visit:\n\n${authorizeUrl}\n\nWaiting for the callback on ${REDIRECT_URI} …\n`,
  );
  const { code } = await callback;

  // RFC 8707: the resource indicator must be repeated at the token exchange
  // for Logto to issue a JWT access token audience-restricted to it (and to
  // grant the offline_access refresh token alongside the API scopes).
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  const session = sessionFromTokens(tokens);
  await writeSession(session);
  return session;
};

// ---------------------------------------------------------------------------
// Session loading with transparent refresh (offline_access → refresh_token grant)
// ---------------------------------------------------------------------------
const refreshSession = async (session: CachedSession): Promise<CachedSession> => {
  if (session.refreshToken === undefined) {
    throw new Error(
      `SSO token expired at ${new Date(session.expiresAt).toISOString()} and no refresh token is cached; run platform login.`,
    );
  }
  try {
    const tokens = await tokenRequest({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: session.refreshToken,
      resource: RESOURCE,
    });
    const next = sessionFromTokens(tokens, session);
    await writeSession(next);
    return next;
  } catch (error) {
    throw new Error(
      `SSO token refresh failed (${error instanceof Error ? error.message : String(error)}); run platform login.`,
      { cause: error },
    );
  }
};

export const requireSession = Effect.tryPromise({
  try: async () => {
    const session = await loadSession();
    if (session.expiresAt <= Date.now()) {
      return await refreshSession(session);
    }
    return session;
  },
  catch: (cause) =>
    userError(cause instanceof Error ? cause.message : "SSO session unavailable; run platform login.", cause),
});

/** Runs once per toCli invocation, so token cache updates need no CLI restart. */
export const ssoHeaders = Effect.map(requireSession, (session) => ({
  Authorization: `${session.tokenType} ${session.accessToken}`,
}));

/**
 * Domain.protocolHttp + the same NDJSON serialization, with real HTTP auth.
 * beta.87 puts toCli's headers in the RPC envelope but never copies them to
 * the HTTP request, so this transport adapter supplies the header apps verify.
 */
export const ssoProtocolHttp = (url: string) =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const targeted = HttpClient.mapRequest(client, HttpClientRequest.prependUrl(url));
      const authenticated = HttpClient.mapRequestEffect(targeted, (request) =>
        requireSession.pipe(
          Effect.mapError(
            (error) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: error,
                  description: error.message,
                }),
              }),
          ),
          Effect.map((session) =>
            HttpClientRequest.setHeader(
              request,
              "Authorization",
              `${session.tokenType} ${session.accessToken}`,
            ),
          ),
        ),
      );
      return yield* RpcClient.makeProtocolHttp(authenticated);
    }),
  ).pipe(Layer.provide(RpcSerialization.layerNdjson));

// ---------------------------------------------------------------------------
// Dev-issuer fallback (local development without the hosted Logto). Enabled
// only by env switch so production behavior is the live flow by default.
// ---------------------------------------------------------------------------
const DevTokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
});
const decodeDevToken = Schema.decodeUnknownSync(DevTokenResponse);

const mintDevSession = async (): Promise<CachedSession> => {
  const issuer = (process.env.PLATFORM_OIDC_ISSUER ?? "http://127.0.0.1:4010").replace(/\/+$/, "");
  const audience = process.env.PLATFORM_OIDC_AUDIENCE ?? "my-app";
  const subject = process.env.PLATFORM_DEV_SUB ?? "user-1";
  const name = process.env.PLATFORM_DEV_NAME ?? "Ada";
  const query = new URLSearchParams({ sub: subject, name, aud: audience });
  const response = await fetch(`${issuer}/dev/token?${query}`);
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Dev issuer returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  const token = decodeDevToken(body);
  const session: CachedSession = {
    version: 2,
    accessToken: token.access_token,
    tokenType: token.token_type,
    issuer,
    audience,
    subject,
    name,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  await writeSession(session);
  return session;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
export const login = Command.make("login", {}, () =>
  Effect.gen(function* () {
    const useDevIssuer = process.env.PLATFORM_AUTH_MODE === "dev";
    const session = yield* Effect.tryPromise({
      try: useDevIssuer ? mintDevSession : liveLogin,
      catch: (cause) => userError(`Login failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
    });
    yield* Console.log(
      `Logged in as ${session.name} (${session.subject}); token expires ${new Date(session.expiresAt).toISOString()}.`,
    );
  }),
).pipe(
  Command.withDescription(
    "Log in via the OIDC issuer (loopback PKCE against Logto; PLATFORM_AUTH_MODE=dev uses the local dev issuer)",
  ),
);

export const logout = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    // Best-effort revocation of the refresh token, then clear the cache.
    const cached = yield* Effect.tryPromise({ try: loadSession, catch: () => userError("no session") }).pipe(
      Effect.option,
    );
    if (cached._tag === "Some" && cached.value.refreshToken !== undefined) {
      yield* Effect.tryPromise({
        try: async () => {
          const { token_endpoint } = await fetchDiscovery();
          const revocation = token_endpoint.replace(/\/token$/, "/token/revocation");
          await fetch(revocation, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: CLIENT_ID, token: cached.value.refreshToken ?? "" }),
          });
        },
        catch: () => userError("revocation failed"),
      }).pipe(Effect.ignore);
    }
    yield* Effect.tryPromise({
      try: () => rm(authFile, { force: true }),
      catch: (cause) => userError(`Logout failed: ${String(cause)}`, cause),
    });
    yield* Console.log("Logged out; cached SSO token removed.");
  }),
).pipe(Command.withDescription("Revoke and remove the cached SSO session"));

export const whoami = Command.make("whoami", {}, () =>
  Effect.gen(function* () {
    const session = yield* requireSession;
    const claims = session.idToken !== undefined ? decodeJwtPayload(session.idToken) : {};
    yield* Console.log(
      JSON.stringify(
        {
          subject: session.subject,
          name: session.name,
          issuer: session.issuer,
          audience: session.audience,
          expiresAt: new Date(session.expiresAt).toISOString(),
          claims,
        },
        null,
        2,
      ),
    );
  }),
).pipe(Command.withDescription("Show the cached SSO identity (ID-token claims) without printing the access token"));

export const authCommands = [login, logout, whoami] as const;
