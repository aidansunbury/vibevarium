import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { createRemoteJWKSet, errors, jwtVerify } from "jose"
import type { RemoteJWKSet } from "jose"

export const Actor = Schema.Struct({
  sub: Schema.String,
  name: Schema.optional(Schema.String),
  azp: Schema.optional(Schema.String),
  tokenType: Schema.optional(Schema.String)
})
export type Actor = typeof Actor.Type

export class CurrentActor extends Context.Service<CurrentActor, Actor>()("@vibevarium/auth/CurrentActor") {}

export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()("DiscoveryError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class KeyRefreshError extends Schema.TaggedError<KeyRefreshError>()("KeyRefreshError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class InvalidTokenError extends Schema.TaggedError<InvalidTokenError>()("InvalidTokenError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class InvalidAudienceError extends Schema.TaggedError<InvalidAudienceError>()("InvalidAudienceError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class InvalidIssuerError extends Schema.TaggedError<InvalidIssuerError>()("InvalidIssuerError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class TokenExpiredError extends Schema.TaggedError<TokenExpiredError>()("TokenExpiredError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export type AuthError = InvalidTokenError | InvalidAudienceError | InvalidIssuerError | TokenExpiredError

export interface AuthConfig {
  readonly issuer: string
  readonly audience: string
  readonly clockTolerance?: number | undefined
  readonly jwksCacheMaxAge?: number | undefined
  readonly jwksCooldown?: number | undefined
}

const DiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String
})

const normalizeIssuer = (issuer: string) => issuer.replace(/\/+$/, "")
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

const mapJwtError = (cause: unknown): AuthError => {
  const message = errorMessage(cause)
  if (cause instanceof errors.JWTExpired) {
    return new TokenExpiredError({ message, cause })
  }
  if (cause instanceof errors.JWTClaimValidationFailed) {
    if (cause.claim === "aud") {
      return new InvalidAudienceError({ message, cause })
    }
    if (cause.claim === "iss") {
      return new InvalidIssuerError({ message, cause })
    }
  }
  return new InvalidTokenError({ message, cause })
}

const makeAuth = (config: AuthConfig) =>
  Effect.gen(function*() {
    const issuer = normalizeIssuer(config.issuer)
    const discoveryUrl = yield* Effect.try({
      try: () => new URL(`${issuer}/.well-known/openid-configuration`),
      catch: (cause) => new DiscoveryError({ message: `Invalid issuer URL: ${config.issuer}`, cause })
    })
    const response = yield* Effect.tryPromise({
      try: () => fetch(discoveryUrl),
      catch: (cause) => new DiscoveryError({ message: `Could not fetch ${discoveryUrl}`, cause })
    })
    if (!response.ok) {
      return yield* new DiscoveryError({
        message: `Discovery request failed with HTTP ${response.status}`,
        cause: new Error(`GET ${discoveryUrl} returned ${response.status}`)
      })
    }
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new DiscoveryError({ message: "Discovery response was not JSON", cause })
    })
    const discovery = yield* Schema.decodeUnknownEffect(DiscoveryDocument)(json).pipe(
      Effect.mapError((cause) => new DiscoveryError({ message: "Invalid OIDC discovery document", cause }))
    )
    if (normalizeIssuer(discovery.issuer) !== issuer) {
      return yield* new DiscoveryError({
        message: `Discovery issuer ${discovery.issuer} does not match configured issuer ${issuer}`,
        cause: new Error("OIDC issuer mismatch")
      })
    }
    const jwksUrl = yield* Effect.try({
      try: () => new URL(discovery.jwks_uri),
      catch: (cause) => new DiscoveryError({ message: "Discovery document has an invalid jwks_uri", cause })
    })
    const jwks: RemoteJWKSet = createRemoteJWKSet(jwksUrl, {
      ...config.jwksCacheMaxAge === undefined ? {} : { cacheMaxAge: config.jwksCacheMaxAge },
      ...config.jwksCooldown === undefined ? {} : { cooldownDuration: config.jwksCooldown }
    })

    const verify = Effect.fnUntraced(function*(token: string, audience = config.audience) {
      const { payload } = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(token, jwks, {
            issuer,
            audience,
            ...config.clockTolerance === undefined ? {} : { clockTolerance: config.clockTolerance },
            requiredClaims: ["sub", "exp"]
          }),
        catch: mapJwtError
      })
      if (audience === config.audience && typeof payload.sub === "string" &&
          payload.sub.startsWith("admin/vibevarium-m2m-")) {
        return yield* new InvalidTokenError({ message: "App credentials require the app audience", cause: undefined })
      }
      return yield* Schema.decodeUnknownEffect(Actor)(payload).pipe(
        Effect.mapError((cause) =>
          new InvalidTokenError({ message: "Verified token has invalid actor claims", cause })
        )
      )
    })

    return Auth.of({
      issuer,
      audience: config.audience,
      verify,
      refreshJwks: () =>
        Effect.tryPromise({
          try: () => jwks.reload(),
          catch: (cause) => new KeyRefreshError({ message: "Could not refresh issuer JWKS", cause })
        }).pipe(Effect.asVoid)
    })
  })

export class Auth extends Context.Service<Auth, {
  readonly issuer: string
  readonly audience: string
  readonly verify: (token: string, audience?: string) => Effect.Effect<Actor, AuthError>
  readonly refreshJwks: () => Effect.Effect<void, KeyRefreshError>
}>()("@vibevarium/auth/Auth") {
  static readonly layer = (config: AuthConfig): Layer.Layer<Auth, DiscoveryError> =>
    Layer.effect(Auth)(makeAuth(config))
}

const unauthorized = (description: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'Bearer error="invalid_token"'
      }
    }
  )

export const requireAuth = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Auth | HttpServerRequest | Exclude<R, CurrentActor>
> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest
    const match = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)
    if (!match) {
      return unauthorized("Expected an Authorization: Bearer token")
    }
    const auth = yield* Auth
    return yield* auth.verify(match[1]).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(unauthorized("Token verification failed")),
        onSuccess: (actor) => handler.pipe(Effect.provideService(CurrentActor, actor))
      })
    )
  })

const DevTokenResponse = Schema.Struct({
  access_token: Schema.String,
  id_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number
})
export type DevTokenResponse = typeof DevTokenResponse.Type

export class DevTokenError extends Schema.TaggedError<DevTokenError>()("DevTokenError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export interface DevTokenOptions {
  readonly issuer: string
  readonly sub: string
  readonly audience: string
  readonly name?: string | undefined
  readonly expiresIn?: number | undefined
}

export const fetchDevToken = Effect.fnUntraced(function*(options: DevTokenOptions) {
  const url = yield* Effect.try({
    try: () => new URL("/dev/token", normalizeIssuer(options.issuer)),
    catch: (cause) => new DevTokenError({ message: "Invalid dev-issuer URL", cause })
  })
  url.searchParams.set("sub", options.sub)
  url.searchParams.set("aud", options.audience)
  if (options.name !== undefined) {
    url.searchParams.set("name", options.name)
  }
  if (options.expiresIn !== undefined) {
    url.searchParams.set("expires_in", String(options.expiresIn))
  }
  const response = yield* Effect.tryPromise({
    try: () => fetch(url),
    catch: (cause) => new DevTokenError({ message: `Could not fetch ${url}`, cause })
  })
  if (!response.ok) {
    return yield* new DevTokenError({
      message: `Dev token request failed with HTTP ${response.status}`,
      cause: new Error(`GET ${url} returned ${response.status}`)
    })
  }
  const json = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new DevTokenError({ message: "Dev token response was not JSON", cause })
  })
  return yield* Schema.decodeUnknownEffect(DevTokenResponse)(json).pipe(
    Effect.mapError((cause) => new DevTokenError({ message: "Invalid dev token response", cause }))
  )
})

export const DevAuth = {
  fetchToken: fetchDevToken
} as const
