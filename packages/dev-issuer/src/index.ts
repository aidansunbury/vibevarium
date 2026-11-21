import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose"
import type { JWK } from "jose"

export interface DevIssuerOptions {
  readonly port?: number | undefined
  readonly host?: string | undefined
  readonly issuer?: string | undefined
  readonly audiences?: ReadonlyArray<string> | undefined
  readonly tokenTtlSeconds?: number | undefined
}

export interface DevIssuer {
  readonly issuer: string
  readonly port: number
  readonly close: () => Promise<void>
}

interface AuthorizationCode {
  readonly sub: string
  readonly name: string | undefined
  readonly audience: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly nonce: string | undefined
  readonly expiresAt: number
}

const normalizeIssuer = (issuer: string) => issuer.replace(/\/+$/, "")

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  })
  response.end(JSON.stringify(body))
}

const oauthError = (response: ServerResponse, description: string, status = 400) => {
  sendJson(response, status, { error: "invalid_request", error_description: description })
}

const readForm = async (request: IncomingMessage) => {
  let body = ""
  request.setEncoding("utf8")
  for await (const chunk of request) {
    body += chunk
    if (body.length > 16_384) {
      throw new Error("Token request body is too large")
    }
  }
  return new URLSearchParams(body)
}

export const startDevIssuer = async (options: DevIssuerOptions = {}): Promise<DevIssuer> => {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const audiences = options.audiences ?? ["my-app"]
  const allowedAudiences = new Set(audiences)
  const defaultAudience = audiences[0]
  if (!defaultAudience || allowedAudiences.size === 0 || audiences.some((audience) => audience.length === 0)) {
    throw new Error("dev-issuer requires at least one non-empty audience")
  }
  const tokenTtlSeconds = options.tokenTtlSeconds ?? 3600
  if (!Number.isInteger(tokenTtlSeconds)) {
    throw new Error("tokenTtlSeconds must be an integer")
  }

  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true })
  const kid = randomUUID()
  const publicJwk: JWK = {
    ...await exportJWK(publicKey),
    kid,
    alg: "RS256",
    use: "sig"
  }
  const codes = new Map<string, AuthorizationCode>()
  let issuer = normalizeIssuer(options.issuer ?? "")

  const mintTokenPair = async (
    input: {
      readonly sub: string
      readonly name: string | undefined
      readonly audience: string
      readonly ttlSeconds: number
      readonly nonce?: string | undefined
    }
  ) => {
    const now = Math.floor(Date.now() / 1000)
    const claims = input.name === undefined ? {} : { name: input.name }
    const makeToken = (typ: string, extraClaims: Record<string, string> = {}) =>
      new SignJWT({ ...claims, ...extraClaims })
        .setProtectedHeader({ alg: "RS256", kid, typ })
        .setIssuer(issuer)
        .setSubject(input.sub)
        .setAudience(input.audience)
        .setIssuedAt(now)
        .setExpirationTime(now + input.ttlSeconds)
        .setJti(randomUUID())
        .sign(privateKey)

    const [accessToken, idToken] = await Promise.all([
      makeToken("at+jwt"),
      makeToken("JWT", input.nonce === undefined ? {} : { nonce: input.nonce })
    ])
    return {
      access_token: accessToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: input.ttlSeconds,
      scope: "openid profile"
    }
  }

  const handleDevToken = async (url: URL, response: ServerResponse) => {
    const sub = url.searchParams.get("sub") ?? "user-1"
    const name = url.searchParams.get("name") ?? "Ada"
    const audience = url.searchParams.get("aud") ?? defaultAudience
    const ttlParam = url.searchParams.get("expires_in")
    const ttlSeconds = ttlParam === null ? tokenTtlSeconds : Number(ttlParam)
    if (!sub) return oauthError(response, "sub must not be empty")
    if (!allowedAudiences.has(audience)) {
      return oauthError(response, `Unsupported aud. Configure one of: ${[...allowedAudiences].join(", ")}`)
    }
    if (!Number.isInteger(ttlSeconds)) {
      return oauthError(response, "expires_in must be an integer number of seconds")
    }
    sendJson(response, 200, await mintTokenPair({ sub, name, audience, ttlSeconds }))
  }

  const handleAuthorize = (url: URL, response: ServerResponse) => {
    const clientId = url.searchParams.get("client_id")
    const redirectUri = url.searchParams.get("redirect_uri")
    const codeChallenge = url.searchParams.get("code_challenge")
    const method = url.searchParams.get("code_challenge_method")
    const responseType = url.searchParams.get("response_type")
    const scope = url.searchParams.get("scope") ?? ""
    if (responseType !== "code") return oauthError(response, "Only response_type=code is supported")
    if (!clientId || !allowedAudiences.has(clientId)) {
      return oauthError(response, "client_id must be one of the configured audiences")
    }
    if (!redirectUri) return oauthError(response, "redirect_uri is required")
    let redirect: URL
    try {
      redirect = new URL(redirectUri)
      if (redirect.protocol !== "http:" && redirect.protocol !== "https:") throw new Error("Unsupported protocol")
    } catch {
      return oauthError(response, "redirect_uri must be an absolute HTTP(S) URL")
    }
    if (!codeChallenge || method !== "S256") {
      return oauthError(response, "PKCE with code_challenge_method=S256 is required")
    }
    if (!scope.split(/\s+/).includes("openid")) {
      return oauthError(response, "scope must include openid")
    }

    const code = randomUUID()
    codes.set(code, {
      sub: url.searchParams.get("sub") ?? "user-1",
      name: url.searchParams.get("name") ?? "Ada",
      audience: clientId,
      clientId,
      redirectUri,
      codeChallenge,
      nonce: url.searchParams.get("nonce") ?? undefined,
      expiresAt: Date.now() + 5 * 60_000
    })
    redirect.searchParams.set("code", code)
    const state = url.searchParams.get("state")
    if (state !== null) redirect.searchParams.set("state", state)
    response.writeHead(302, { location: redirect.toString(), "cache-control": "no-store" })
    response.end()
  }

  const handleToken = async (request: IncomingMessage, response: ServerResponse) => {
    const form = await readForm(request)
    const code = form.get("code")
    const verifier = form.get("code_verifier")
    if (form.get("grant_type") !== "authorization_code" || !code || !verifier) {
      return oauthError(response, "grant_type=authorization_code, code, and code_verifier are required")
    }
    const grant = codes.get(code)
    codes.delete(code)
    if (!grant || grant.expiresAt < Date.now()) {
      return sendJson(response, 400, { error: "invalid_grant", error_description: "Code is invalid or expired" })
    }
    if (form.get("client_id") !== grant.clientId || form.get("redirect_uri") !== grant.redirectUri) {
      return sendJson(response, 400, { error: "invalid_grant", error_description: "client_id or redirect_uri mismatch" })
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    const actualChallenge = base64url.encode(new Uint8Array(digest))
    if (actualChallenge !== grant.codeChallenge) {
      return sendJson(response, 400, { error: "invalid_grant", error_description: "PKCE verification failed" })
    }
    sendJson(response, 200, await mintTokenPair({
      sub: grant.sub,
      name: grant.name,
      audience: grant.audience,
      ttlSeconds: tokenTtlSeconds,
      nonce: grant.nonce
    }))
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1")
      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return sendJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile"],
          claims_supported: ["iss", "sub", "aud", "exp", "iat", "name", "nonce"]
        }, { "cache-control": "public, max-age=60" })
      }
      if (request.method === "GET" && url.pathname === "/jwks") {
        return sendJson(response, 200, { keys: [publicJwk] }, { "cache-control": "public, max-age=60" })
      }
      if (request.method === "GET" && url.pathname === "/dev/token") {
        return await handleDevToken(url, response)
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        return handleAuthorize(url, response)
      }
      if (request.method === "POST" && url.pathname === "/token") {
        return await handleToken(request, response)
      }
      if (url.pathname === "/token" || url.pathname === "/dev/token" || url.pathname === "/authorize") {
        return sendJson(response, 405, { error: "method_not_allowed" }, { allow: url.pathname === "/token" ? "POST" : "GET" })
      }
      sendJson(response, 404, { error: "not_found" })
    })().catch((cause: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "server_error", error_description: cause instanceof Error ? cause.message : String(cause) })
      } else {
        response.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause)
    server.once("error", onError)
    server.listen(port, host, () => {
      server.off("error", onError)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error("dev-issuer did not bind to a TCP address")
  }
  if (!issuer) {
    const hostname = address.address.includes(":") ? `[${address.address}]` : address.address
    issuer = `http://${hostname}:${address.port}`
  }

  return {
    issuer,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((cause) => cause ? reject(cause) : resolve())
    })
  }
}
