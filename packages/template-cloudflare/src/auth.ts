/**
 * Optional OIDC auth seam, vendored from @terrarium/auth so generated apps
 * stay self-contained (no workspace dependencies).
 *
 * Off by default. Setting TERRARIUM_ISSUER (and optionally
 * TERRARIUM_AUDIENCE) turns it on: every API surface requires a valid
 * bearer token from that issuer, verified against the issuer's JWKS with
 * the audience checked. `/health` and `/auth/status` stay public so the
 * SPA can discover the mode.
 *
 * When the hosted OIDC provider (Logto) is live, only the two env values
 * change — the middleware, the SPA's token handling, and `/whoami` stay
 * identical.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { RemoteJWKSet } from "jose";
import { AuthFlow, sessionFromCookie } from "./auth-flow.ts";

export const Actor = Schema.Struct({
  sub: Schema.String,
  name: Schema.optional(Schema.String),
});
export type Actor = typeof Actor.Type;

export class CurrentActor extends Context.Service<CurrentActor, Actor>()("app/auth/CurrentActor") {}

export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()("DiscoveryError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface AuthConfig {
  readonly issuer: string;
  /** Accepted audiences: the app's own + the platform's (Option B′ — one platform token opens every app). */
  readonly audience: string | ReadonlyArray<string>;
}

const DiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
});

const normalizeIssuer = (issuer: string) => issuer.replace(/\/+$/, "");
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class Auth extends Context.Service<Auth, {
  readonly issuer: string;
  readonly audience: string | ReadonlyArray<string>;
  readonly verify: (token: string) => Effect.Effect<Actor, AuthError>;
}>()("app/auth/Auth") {
  static readonly layer = (config: AuthConfig): Layer.Layer<Auth, DiscoveryError> =>
    Layer.effect(Auth)(makeAuth(config));
}

const makeAuth = (config: AuthConfig) =>
  Effect.gen(function*() {
    const issuer = normalizeIssuer(config.issuer);
    const discoveryUrl = new URL(`${issuer}/.well-known/openid-configuration`);
    const response = yield* Effect.tryPromise({
      try: () => fetch(discoveryUrl),
      catch: (cause) => new DiscoveryError({ message: `Could not fetch ${discoveryUrl}`, cause }),
    });
    if (!response.ok) {
      return yield* new DiscoveryError({
        message: `Discovery request failed with HTTP ${response.status}`,
        cause: new Error(`GET ${discoveryUrl} returned ${response.status}`),
      });
    }
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new DiscoveryError({ message: "Discovery response was not JSON", cause }),
    });
    const discovery = yield* Schema.decodeUnknownEffect(DiscoveryDocument)(json).pipe(
      Effect.mapError((cause) => new DiscoveryError({ message: "Invalid OIDC discovery document", cause })),
    );
    if (normalizeIssuer(discovery.issuer) !== issuer) {
      return yield* new DiscoveryError({
        message: `Discovery issuer ${discovery.issuer} does not match configured issuer ${issuer}`,
        cause: new Error("OIDC issuer mismatch"),
      });
    }
    const jwks: RemoteJWKSet = createRemoteJWKSet(new URL(discovery.jwks_uri));

    const verify = Effect.fnUntraced(function*(token: string) {
      const { payload } = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(token, jwks, {
            issuer,
            audience: config.audience as string | string[],
            requiredClaims: ["sub", "exp"],
          }),
        catch: (cause) => new AuthError({ message: errorMessage(cause), cause }),
      });
      return yield* Schema.decodeUnknownEffect(Actor)(payload).pipe(
        Effect.mapError((cause) => new AuthError({ message: "Verified token has invalid actor claims", cause })),
      );
    });

    return Auth.of({ issuer, audience: config.audience as string | string[], verify });
  });

/** Read the auth config from the worker environment; undefined means auth is off. */
export const authConfigFromEnv = (env: Record<string, unknown>): AuthConfig | undefined => {
  const issuer = env.TERRARIUM_ISSUER;
  if (typeof issuer !== "string" || issuer.length === 0) return undefined;
  const own = typeof env.TERRARIUM_AUDIENCE === "string" && env.TERRARIUM_AUDIENCE.length > 0
    ? env.TERRARIUM_AUDIENCE
    : "app.terrarium.local";
  // The platform audience (Option B′): one platform token opens every app. Apps
  // accept both their own audience and the platform's. TERRARIUM_PLATFORM_AUDIENCE
  // defaults to the platform MCP resource on the base domain.
  const platform = typeof env.TERRARIUM_PLATFORM_AUDIENCE === "string" && env.TERRARIUM_PLATFORM_AUDIENCE.length > 0
    ? env.TERRARIUM_PLATFORM_AUDIENCE
    : undefined;
  return { issuer, audience: platform === undefined ? [own] : [own, platform] };
};

const unauthorized = (description: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'Bearer error="invalid_token"',
      },
    },
  );

const wantsHtml = (request: HttpServerRequest) => {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
};

/**
 * Verify the request and provide CurrentActor to the handler. Credentials,
 * in precedence order:
 *
 *  1. `Authorization: Bearer` — verified against the issuer JWKS with the
 *     accepted audiences (own + platform, Option B′). This is how the
 *     meta-MCP and CLI call the app.
 *  2. The signed session cookie from the auth-code + PKCE flow
 *     (`/auth/login` → `/auth/callback`) — its embedded platform-audience
 *     access token is verified exactly like a bearer token. This is how the
 *     first-party SPA calls the API.
 *
 * No valid credential: API-style requests get a 401 with WWW-Authenticate;
 * browser page loads (Accept: text/html) get a 302 to /auth/login — there is
 * no logged-out UI state, unauthenticated users go straight to the provider.
 */
export const requireAuth = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Auth | AuthFlow | HttpServerRequest | Exclude<R, CurrentActor>
> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest;
    const auth = yield* Auth;

    // 1. Bearer token (meta-MCP, CLI, scripts).
    const match = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
    if (match) {
      return yield* auth.verify(match[1]).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.succeed(unauthorized(error instanceof Error ? error.message : "Token verification failed")),
          onSuccess: (actor) => handler.pipe(Effect.provideService(CurrentActor, actor)),
        }),
      );
    }

    // 2. Signed session cookie (first-party SPA via /auth/login).
    const flowOption = yield* Effect.serviceOption(AuthFlow);
    if (flowOption._tag === "Some") {
      const session = yield* Effect.promise(() =>
        sessionFromCookie(flowOption.value, request.cookies.terrarium_session)
      );
      if (session !== undefined) {
        const verified = yield* Effect.result(auth.verify(session.accessToken));
        if (verified._tag === "Success") {
          return yield* handler.pipe(
            Effect.provideService(CurrentActor, { sub: session.sub, name: session.name }),
          );
        }
        // Session token no longer verifies (rotated keys, audience change) —
        // fall through to unauthenticated handling.
      }
    }

    if (wantsHtml(request)) {
      return HttpServerResponse.redirect("/auth/login", {
        headers: { "cache-control": "no-store" },
      });
    }
    return unauthorized("Expected an Authorization: Bearer token or a session cookie");
  });
