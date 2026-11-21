import { createHash } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFakeOAuthProvider } from "../src/index.ts"
import type { FakeOAuthProvider } from "../src/index.ts"

let provider: FakeOAuthProvider
const verifier = "test-verifier-that-is-long-enough-for-pkce"
const challenge = createHash("sha256").update(verifier).digest("base64url")
const redirectUri = "https://control-plane.test/connections/callback"

const decodeHtml = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&amp;", "&")
const formFromHtml = (html: string) => {
  const fields = new URLSearchParams()
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    if (match[1] && match[2] !== undefined) fields.set(decodeHtml(match[1]), decodeHtml(match[2]))
  }
  return fields
}

const issueCode = async (state: string) => {
  const url = new URL(provider.authorizeUrl)
  url.search = new URLSearchParams({
    response_type: "code",
    response_mode: "form_post",
    client_id: "test-client",
    redirect_uri: redirectUri,
    scope: "read:metrics",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString()
  const page = await fetch(url)
  expect(page.status).toBe(200)
  const fields = formFromHtml(await page.text())
  fields.set("provider_user", "grace")
  const approved = await fetch(provider.authorizeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fields
  })
  const callback = formFromHtml(await approved.text())
  expect(callback.get("state")).toBe(state)
  return callback.get("code") ?? ""
}

const tokenRequest = (form: URLSearchParams) => fetch(provider.tokenUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    ...Object.fromEntries(form),
    client_id: "test-client",
    client_secret: "test-secret"
  })
})

beforeAll(async () => {
  provider = await startFakeOAuthProvider({
    name: "datadog",
    clients: [{ clientId: "test-client", clientSecret: "test-secret", redirectUris: [redirectUri] }]
  })
})

afterAll(async () => {
  await provider.close()
})

describe("fake OAuth provider", () => {
  it("does real PKCE, RS256, protected APIs, and rotating refresh grants", async () => {
    const wrongCode = await issueCode("wrong-verifier-attempt")
    const wrongVerifier = await tokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code: wrongCode,
      redirect_uri: redirectUri,
      code_verifier: "wrong"
    }))
    expect(wrongVerifier.status).toBe(400)
    expect(await wrongVerifier.json()).toMatchObject({ error: "invalid_grant" })

    const code = await issueCode("successful-attempt")
    const exchanged = await tokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    }))
    expect(exchanged.status).toBe(200)
    const tokens = await exchanged.json() as {
      access_token: string
      refresh_token: string
      scope: string
    }
    expect(tokens.scope).toBe("read:metrics")

    const verified = await jwtVerify(
      tokens.access_token,
      createRemoteJWKSet(new URL(provider.jwksUrl)),
      { issuer: provider.issuer, audience: `${provider.issuer}/api/v1` }
    )
    expect(verified.payload.sub).toBe("grace")
    expect(verified.protectedHeader.alg).toBe("RS256")

    const reusedCode = await tokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    }))
    expect(reusedCode.status).toBe(400)

    const userinfo = await fetch(provider.userinfoUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    })
    expect(await userinfo.json()).toMatchObject({ sub: "grace", email: "grace@datadog.test" })
    const metrics = await fetch(`${provider.apiBaseUrl}/metrics`, {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    })
    expect(metrics.status).toBe(200)
    expect(await metrics.json()).toMatchObject({ status: "ok" })

    const refreshed = await tokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token
    }))
    expect(refreshed.status).toBe(200)
    const rotated = await refreshed.json() as { access_token: string; refresh_token: string }
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
    expect(rotated.access_token).not.toBe(tokens.access_token)

    const replayedRefresh = await tokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token
    }))
    expect(replayedRefresh.status).toBe(400)
    expect(await replayedRefresh.json()).toMatchObject({ error: "invalid_grant" })
    expect(provider.snapshot()).toMatchObject({
      authorizationCodesRedeemed: 1,
      refreshTokenRotations: 1,
      apiRequests: 1
    })
  }, 20_000)

  it("starts independent providers with different names and ephemeral ports", async () => {
    const github = await startFakeOAuthProvider({ name: "github", port: 0 })
    try {
      expect(github.issuer).not.toBe(provider.issuer)
      expect(github.port).not.toBe(provider.port)
      expect(await (await fetch(`${github.issuer}/health`)).json()).toEqual({ ok: true, provider: "github" })
    } finally {
      await github.close()
    }
  })
})
