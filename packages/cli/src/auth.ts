import { rm } from "node:fs/promises";
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

const CachedSession = Schema.Struct({
  version: Schema.Literal(1),
  accessToken: Schema.String,
  tokenType: Schema.String,
  issuer: Schema.String,
  audience: Schema.String,
  subject: Schema.String,
  name: Schema.String,
  expiresAt: Schema.Number,
});

const DevTokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
});

type CachedSession = typeof CachedSession.Type;

const userError = (message: string, cause: unknown = message) =>
  new CliError.UserError({ cause, userMessage: message });

const decodeSession = Schema.decodeUnknownSync(CachedSession);
const decodeDevToken = Schema.decodeUnknownSync(DevTokenResponse);

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

export const requireSession = Effect.tryPromise({
  try: async () => {
    const session = await loadSession();
    if (session.expiresAt <= Date.now()) {
      throw new Error(
        `SSO token expired at ${new Date(session.expiresAt).toISOString()}; run platform login.`,
      );
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

const mintDevSession = async (): Promise<CachedSession> => {
  // OIDC SEAM: replace only this dev-token grant with loopback browser PKCE
  // (discovery -> authorize -> code exchange). CachedSession and ssoHeaders stay put.
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
    version: 1,
    accessToken: token.access_token,
    tokenType: token.token_type,
    issuer,
    audience,
    subject,
    name,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  await writeJsonFile(authFile, session);
  return session;
};

export const login = Command.make("login", {}, () =>
  Effect.gen(function* () {
    const session = yield* Effect.tryPromise({
      try: mintDevSession,
      catch: (cause) => userError(`Login failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
    });
    yield* Console.log(
      `Logged in as ${session.name} (${session.subject}); token expires ${new Date(session.expiresAt).toISOString()}.`,
    );
  }),
).pipe(Command.withDescription("Log in through the configured OIDC issuer (dev-token grant in this spike)"));

export const logout = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => rm(authFile, { force: true }),
      catch: (cause) => userError(`Logout failed: ${String(cause)}`, cause),
    });
    yield* Console.log("Logged out; cached SSO token removed.");
  }),
).pipe(Command.withDescription("Remove the cached SSO token"));

export const whoami = Command.make("whoami", {}, () =>
  Effect.gen(function* () {
    const session = yield* requireSession;
    yield* Console.log(
      JSON.stringify(
        {
          subject: session.subject,
          name: session.name,
          issuer: session.issuer,
          audience: session.audience,
          expiresAt: new Date(session.expiresAt).toISOString(),
        },
        null,
        2,
      ),
    );
  }),
).pipe(Command.withDescription("Show the cached SSO identity without printing its token"));

export const authCommands = [login, logout, whoami] as const;
