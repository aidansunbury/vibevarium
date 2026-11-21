import * as http from "node:http"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Auth,
  CurrentActor,
  DevAuth,
  InvalidAudienceError,
  InvalidTokenError,
  requireAuth,
  TokenExpiredError
} from "@terrarium/auth"
import { startDevIssuer } from "@terrarium/dev-issuer"
import type { DevIssuer } from "@terrarium/dev-issuer"

let devIssuer: DevIssuer
let authLayer: ReturnType<typeof Auth.layer>

beforeAll(async () => {
  devIssuer = await startDevIssuer({
    port: 0,
    audiences: ["my-app", "other-app"]
  })
  authLayer = Auth.layer({ issuer: devIssuer.issuer, audience: "my-app" })
})

afterAll(async () => {
  await devIssuer.close()
})

const verify = (token: string) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return yield* auth.verify(token)
  })

const mint = (options: { readonly audience?: string; readonly expiresIn?: number } = {}) =>
  DevAuth.fetchToken({
    issuer: devIssuer.issuer,
    sub: "user-1",
    name: "Ada",
    audience: options.audience ?? "my-app",
    expiresIn: options.expiresIn
  })

const tamperSignature = (token: string) => {
  const parts = token.split(".")
  const signature = parts[2]
  parts[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`
  return parts.join(".")
}

describe("@terrarium/auth", () => {
  it("verifies a dev token and maps its claims to an Actor", async () => {
    const tokens = await Effect.runPromise(mint())
    const actor = await Effect.runPromise(verify(tokens.access_token).pipe(Effect.provide(authLayer)))
    expect(actor).toEqual({ sub: "user-1", name: "Ada" })

    const idActor = await Effect.runPromise(verify(tokens.id_token).pipe(Effect.provide(authLayer)))
    expect(idActor).toEqual(actor)
  })

  it("rejects a tampered token with InvalidTokenError", async () => {
    const tokens = await Effect.runPromise(mint())
    const error = await Effect.runPromise(
      Effect.flip(verify(tamperSignature(tokens.access_token))).pipe(Effect.provide(authLayer))
    )
    expect(error).toBeInstanceOf(InvalidTokenError)
  })

  it("rejects the wrong audience with InvalidAudienceError", async () => {
    const tokens = await Effect.runPromise(mint({ audience: "other-app" }))
    const error = await Effect.runPromise(
      Effect.flip(verify(tokens.access_token)).pipe(Effect.provide(authLayer))
    )
    expect(error).toBeInstanceOf(InvalidAudienceError)
  })

  it("rejects an expired token with TokenExpiredError", async () => {
    const tokens = await Effect.runPromise(mint({ expiresIn: -60 }))
    const error = await Effect.runPromise(
      Effect.flip(verify(tokens.access_token)).pipe(Effect.provide(authLayer))
    )
    expect(error).toBeInstanceOf(TokenExpiredError)
  })

  it("protects an Effect HttpRouter endpoint and provides CurrentActor", async () => {
    const tokens = await Effect.runPromise(mint())
    const route = HttpRouter.add(
      "GET",
      "/me",
      requireAuth(Effect.gen(function*() {
        const actor = yield* CurrentActor
        return yield* HttpServerResponse.json(actor)
      }))
    )
    const serverLayer = HttpRouter.serve(route, {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provide(authLayer),
      Layer.provideMerge(NodeHttpServer.layer(http.createServer, { port: 0, host: "127.0.0.1" }))
    )

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(serverLayer)
      const server = Context.get(context, HttpServer.HttpServer)
      const baseUrl = HttpServer.formatAddress(server.address)

      const withoutToken = yield* Effect.promise(() => fetch(`${baseUrl}/me`))
      const withoutTokenBody = yield* Effect.promise(() => withoutToken.json())
      const withToken = yield* Effect.promise(() => fetch(`${baseUrl}/me`, {
        headers: { authorization: `Bearer ${tokens.access_token}` }
      }))
      const actor = yield* Effect.promise(() => withToken.json())
      return {
        withoutStatus: withoutToken.status,
        withoutTokenBody,
        withStatus: withToken.status,
        actor
      }
    })))

    expect(result.withoutStatus).toBe(401)
    expect(result.withoutTokenBody).toMatchObject({ error: "invalid_token" })
    expect(result.withStatus).toBe(200)
    expect(result.actor).toEqual({ sub: "user-1", name: "Ada" })
  })
})
