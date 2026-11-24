import { randomUUID } from "node:crypto"
import { base64url, decodeJwt, decodeProtectedHeader } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startDevIssuer } from "@vibevarium/dev-issuer"
import type { DevIssuer } from "@vibevarium/dev-issuer"

let devIssuer: DevIssuer

beforeAll(async () => {
  devIssuer = await startDevIssuer({
    port: 0,
    audiences: ["my-app", "other-app"]
  })
})

afterAll(async () => {
  await devIssuer.close()
})

describe("dev-issuer", () => {
  it("serves OIDC discovery and JWKS", async () => {
    const discoveryResponse = await fetch(`${devIssuer.issuer}/.well-known/openid-configuration`)
    expect(discoveryResponse.status).toBe(200)
    const discovery = await discoveryResponse.json()
    expect(discovery).toMatchObject({
      issuer: devIssuer.issuer,
      authorization_endpoint: `${devIssuer.issuer}/authorize`,
      token_endpoint: `${devIssuer.issuer}/token`,
      jwks_uri: `${devIssuer.issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"]
    })

    const jwksResponse = await fetch(discovery.jwks_uri)
    const jwks = await jwksResponse.json()
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" })
    expect(jwks.keys[0].n).toEqual(expect.any(String))
    expect(jwks.keys[0].d).toBeUndefined()
  })

  it("mints honest RS256 access and ID tokens for a fake user", async () => {
    const response = await fetch(`${devIssuer.issuer}/dev/token?sub=user-1&name=Ada&aud=my-app`)
    expect(response.status).toBe(200)
    const tokens = await response.json()
    expect(tokens.token_type).toBe("Bearer")

    for (const token of [tokens.access_token, tokens.id_token]) {
      expect(decodeProtectedHeader(token)).toMatchObject({ alg: "RS256", kid: expect.any(String) })
      const claims = decodeJwt(token)
      expect(claims).toMatchObject({
        iss: devIssuer.issuer,
        sub: "user-1",
        aud: "my-app",
        name: "Ada"
      })
      expect(claims.exp! - claims.iat!).toBe(3600)
    }
  })

  it("supports authorization code with S256 PKCE", async () => {
    const verifier = randomUUID().replaceAll("-", "").repeat(2)
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    const challenge = base64url.encode(new Uint8Array(digest))
    const authorizationUrl = new URL(`${devIssuer.issuer}/authorize`)
    authorizationUrl.searchParams.set("response_type", "code")
    authorizationUrl.searchParams.set("client_id", "my-app")
    authorizationUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9999/callback")
    authorizationUrl.searchParams.set("scope", "openid profile")
    authorizationUrl.searchParams.set("code_challenge", challenge)
    authorizationUrl.searchParams.set("code_challenge_method", "S256")
    authorizationUrl.searchParams.set("state", "state-123")
    authorizationUrl.searchParams.set("nonce", "nonce-123")
    authorizationUrl.searchParams.set("sub", "pkce-user")
    authorizationUrl.searchParams.set("name", "Grace")

    const authorizationResponse = await fetch(authorizationUrl, { redirect: "manual" })
    expect(authorizationResponse.status).toBe(302)
    const callback = new URL(authorizationResponse.headers.get("location")!)
    expect(callback.searchParams.get("state")).toBe("state-123")
    expect(callback.searchParams.get("code")).toEqual(expect.any(String))

    const tokenResponse = await fetch(`${devIssuer.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        client_id: "my-app",
        redirect_uri: "http://127.0.0.1:9999/callback",
        code_verifier: verifier
      })
    })
    expect(tokenResponse.status).toBe(200)
    const tokens = await tokenResponse.json()
    expect(decodeJwt(tokens.id_token)).toMatchObject({
      iss: devIssuer.issuer,
      sub: "pkce-user",
      aud: "my-app",
      name: "Grace",
      nonce: "nonce-123"
    })
  })
})
