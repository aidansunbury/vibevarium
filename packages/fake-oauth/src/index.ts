import { randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { base64url, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose"
import type { JWK, JWTPayload } from "jose"

export interface FakeOAuthClient {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUris: ReadonlyArray<string>
}

export interface FakeOAuthUser {
  readonly sub: string
  readonly name: string
  readonly email: string
}

export interface FakeOAuthOptions {
  readonly name: string
  readonly port?: number | undefined
  readonly host?: string | undefined
  readonly issuer?: string | undefined
  readonly clients?: ReadonlyArray<FakeOAuthClient> | undefined
  readonly users?: ReadonlyArray<FakeOAuthUser> | undefined
  readonly supportedScopes?: ReadonlyArray<string> | undefined
  readonly accessTokenTtlSeconds?: number | undefined
  readonly authorizationCodeTtlMs?: number | undefined
}

export interface FakeOAuthSnapshot {
  readonly name: string
  readonly authorizationCodesIssued: number
  readonly authorizationCodesRedeemed: number
  readonly refreshTokensIssued: number
  readonly refreshTokenRotations: number
  readonly apiRequests: number
  readonly activeRefreshTokens: number
}

export interface FakeOAuthProvider {
  readonly name: string
  readonly issuer: string
  readonly port: number
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly userinfoUrl: string
  readonly apiBaseUrl: string
  readonly jwksUrl: string
  readonly snapshot: () => FakeOAuthSnapshot
  readonly close: () => Promise<void>
}

interface AuthorizationCode {
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly scopes: ReadonlyArray<string>
  readonly user: FakeOAuthUser
  readonly expiresAt: number
}

interface RefreshToken {
  readonly clientId: string
  readonly user: FakeOAuthUser
  readonly scopes: ReadonlyArray<string>
}

interface AuthorizeInput {
  readonly client: FakeOAuthClient
  readonly redirectUri: string
  readonly scopes: ReadonlyArray<string>
  readonly state: string | undefined
  readonly codeChallenge: string
  readonly responseMode: "query" | "form_post"
}

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;")

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  })
  response.end(JSON.stringify(body))
}

const sendHtml = (response: ServerResponse, status: number, body: string) => {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  })
  response.end(body)
}

const oauthError = (response: ServerResponse, error: string, description: string, status = 400) => {
  sendJson(response, status, { error, error_description: description })
}

const readBody = async (request: IncomingMessage) => {
  let body = ""
  request.setEncoding("utf8")
  for await (const chunk of request) {
    body += chunk
    if (body.length > 65_536) throw new Error("Request body is too large")
  }
  return body
}

const readForm = async (request: IncomingMessage) => new URLSearchParams(await readBody(request))

const hiddenInput = (name: string, value: string | undefined) =>
  value === undefined ? "" : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`

const defaultUsers = (providerName: string): ReadonlyArray<FakeOAuthUser> => [
  { sub: "ada", name: "Ada Lovelace", email: `ada@${providerName}.test` },
  { sub: "grace", name: "Grace Hopper", email: `grace@${providerName}.test` }
]

export const startFakeOAuthProvider = async (options: FakeOAuthOptions): Promise<FakeOAuthProvider> => {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const name = options.name.trim()
  if (!name) throw new Error("fake-oauth requires a provider name")
  const supportedScopes = options.supportedScopes ?? ["read:metrics", "write:metrics"]
  const supportedScopeSet = new Set(supportedScopes)
  const accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600
  const authorizationCodeTtlMs = options.authorizationCodeTtlMs ?? 5 * 60_000
  if (!Number.isInteger(accessTokenTtlSeconds) || accessTokenTtlSeconds <= 0) {
    throw new Error("accessTokenTtlSeconds must be a positive integer")
  }
  const users = options.users ?? defaultUsers(name)
  if (users.length === 0) throw new Error("fake-oauth requires at least one user")
  const usersBySub = new Map(users.map((user) => [user.sub, user]))
  const clients = new Map((options.clients ?? [{
    clientId: "terrarium-control-plane",
    clientSecret: "dev-control-plane-secret",
    redirectUris: ["http://127.0.0.1:4020/connections/callback"]
  }]).map((client) => [client.clientId, client]))

  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true })
  const kid = randomUUID()
  const publicJwk: JWK = { ...await exportJWK(publicKey), kid, alg: "RS256", use: "sig" }
  const codes = new Map<string, AuthorizationCode>()
  const refreshTokens = new Map<string, RefreshToken>()
  let issuer = (options.issuer ?? "").replace(/\/+$/, "")
  const counters = {
    authorizationCodesIssued: 0,
    authorizationCodesRedeemed: 0,
    refreshTokensIssued: 0,
    refreshTokenRotations: 0,
    apiRequests: 0
  }

  const parseAuthorize = (url: URL): AuthorizeInput | { readonly error: string } => {
    if (url.searchParams.get("response_type") !== "code") {
      return { error: "Only response_type=code is supported" }
    }
    const clientId = url.searchParams.get("client_id") ?? ""
    const client = clients.get(clientId)
    if (!client) return { error: "Unknown client_id" }
    const redirectUri = url.searchParams.get("redirect_uri") ?? ""
    if (!client.redirectUris.includes(redirectUri)) return { error: "redirect_uri is not registered for this client" }
    const codeChallenge = url.searchParams.get("code_challenge") ?? ""
    if (!codeChallenge || url.searchParams.get("code_challenge_method") !== "S256") {
      return { error: "PKCE with code_challenge_method=S256 is required" }
    }
    const scopes = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean)
    if (scopes.some((scope) => !supportedScopeSet.has(scope))) return { error: "Requested scope is not supported" }
    const responseMode = url.searchParams.get("response_mode") ?? "query"
    if (responseMode !== "query" && responseMode !== "form_post") return { error: "Unsupported response_mode" }
    return {
      client,
      redirectUri,
      scopes,
      state: url.searchParams.get("state") ?? undefined,
      codeChallenge,
      responseMode
    }
  }

  const renderAuthorize = (url: URL, input: AuthorizeInput) => {
    const fields = [
      ["client_id", input.client.clientId],
      ["redirect_uri", input.redirectUri],
      ["response_type", "code"],
      ["response_mode", input.responseMode],
      ["scope", input.scopes.join(" ")],
      ["state", input.state],
      ["code_challenge", input.codeChallenge],
      ["code_challenge_method", "S256"]
    ] as const
    const optionsHtml = users.map((user) =>
      `<option value="${escapeHtml(user.sub)}">${escapeHtml(user.name)} &lt;${escapeHtml(user.email)}&gt;</option>`
    ).join("")
    const autoSubmit = url.searchParams.get("auto") === "1"
      ? "<script>document.forms.approve.submit()</script>"
      : ""
    return `<!doctype html>
<html><head><title>${escapeHtml(name)} development consent</title></head><body>
<h1>${escapeHtml(name)} (fake provider)</h1>
<p>Client <strong>${escapeHtml(input.client.clientId)}</strong> requests <code>${escapeHtml(input.scopes.join(" "))}</code>.</p>
<form name="approve" method="post" action="${escapeHtml(`${issuer}/authorize`)}">
${fields.map(([key, value]) => hiddenInput(key, value)).join("\n")}
<label>Approving provider user <select name="provider_user">${optionsHtml}</select></label>
<button type="submit">Approve</button>
</form>${autoSubmit}
</body></html>`
  }

  const issueAuthorizationCode = (input: AuthorizeInput, user: FakeOAuthUser) => {
    const code = randomBytes(32).toString("base64url")
    codes.set(code, {
      clientId: input.client.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      user,
      expiresAt: Date.now() + authorizationCodeTtlMs
    })
    counters.authorizationCodesIssued += 1
    return code
  }

  const completeAuthorize = (response: ServerResponse, input: AuthorizeInput, user: FakeOAuthUser) => {
    const code = issueAuthorizationCode(input, user)
    if (input.responseMode === "query") {
      const redirect = new URL(input.redirectUri)
      redirect.searchParams.set("code", code)
      if (input.state !== undefined) redirect.searchParams.set("state", input.state)
      response.writeHead(303, { location: redirect.toString(), "cache-control": "no-store" })
      response.end()
      return
    }
    sendHtml(response, 200, `<!doctype html>
<html><head><title>Return to Terrarium</title></head><body>
<p>Authorization approved. Returning the authorization code to the control plane.</p>
<form name="callback" method="post" action="${escapeHtml(input.redirectUri)}">
${hiddenInput("code", code)}${hiddenInput("state", input.state)}
<noscript><button type="submit">Continue</button></noscript>
</form><script>document.forms.callback.submit()</script>
</body></html>`)
  }

  const authenticateClient = (request: IncomingMessage, form: URLSearchParams) => {
    let clientId = form.get("client_id") ?? ""
    let clientSecret = form.get("client_secret") ?? ""
    const authorization = request.headers.authorization
    if (authorization?.startsWith("Basic ")) {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8")
      const separator = decoded.indexOf(":")
      clientId = decoded.slice(0, separator)
      clientSecret = separator < 0 ? "" : decoded.slice(separator + 1)
    }
    const client = clients.get(clientId)
    return client && client.clientSecret === clientSecret ? client : undefined
  }

  const mintTokenPair = async (clientId: string, user: FakeOAuthUser, scopes: ReadonlyArray<string>, rotated: boolean) => {
    const now = Math.floor(Date.now() / 1000)
    const accessToken = await new SignJWT({ scope: scopes.join(" "), client_id: clientId, name: user.name, email: user.email })
      .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" })
      .setIssuer(issuer)
      .setSubject(user.sub)
      .setAudience(`${issuer}/api/v1`)
      .setIssuedAt(now)
      .setExpirationTime(now + accessTokenTtlSeconds)
      .setJti(randomUUID())
      .sign(privateKey)
    const refreshToken = randomBytes(48).toString("base64url")
    refreshTokens.set(refreshToken, { clientId, user, scopes })
    counters.refreshTokensIssued += 1
    if (rotated) counters.refreshTokenRotations += 1
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: accessTokenTtlSeconds,
      scope: scopes.join(" ")
    }
  }

  const handleToken = async (request: IncomingMessage, response: ServerResponse) => {
    const form = await readForm(request)
    const client = authenticateClient(request, form)
    if (!client) return oauthError(response, "invalid_client", "Client authentication failed", 401)
    const grantType = form.get("grant_type")
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? ""
      const grant = codes.get(code)
      codes.delete(code)
      if (!grant || grant.expiresAt <= Date.now()) {
        return oauthError(response, "invalid_grant", "Authorization code is invalid or expired")
      }
      if (grant.clientId !== client.clientId || grant.redirectUri !== form.get("redirect_uri")) {
        return oauthError(response, "invalid_grant", "client_id or redirect_uri mismatch")
      }
      const verifier = form.get("code_verifier") ?? ""
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
      if (base64url.encode(new Uint8Array(digest)) !== grant.codeChallenge) {
        return oauthError(response, "invalid_grant", "PKCE verification failed")
      }
      counters.authorizationCodesRedeemed += 1
      return sendJson(response, 200, await mintTokenPair(client.clientId, grant.user, grant.scopes, false))
    }
    if (grantType === "refresh_token") {
      const presented = form.get("refresh_token") ?? ""
      const grant = refreshTokens.get(presented)
      refreshTokens.delete(presented)
      if (!grant || grant.clientId !== client.clientId) {
        return oauthError(response, "invalid_grant", "Refresh token is invalid, expired, or already rotated")
      }
      return sendJson(response, 200, await mintTokenPair(client.clientId, grant.user, grant.scopes, true))
    }
    return oauthError(response, "unsupported_grant_type", "Use authorization_code or refresh_token")
  }

  const verifyRequestToken = async (request: IncomingMessage, key: CryptoKey) => {
    const match = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)
    if (!match) throw new Error("Expected a bearer token")
    const { payload } = await jwtVerify(match[1], key, {
      issuer,
      audience: `${issuer}/api/v1`,
      requiredClaims: ["sub", "exp"]
    })
    return payload
  }

  const requireScope = (response: ServerResponse, payload: JWTPayload, scope: string) => {
    const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : []
    if (scopes.includes(scope)) return true
    sendJson(response, 403, { error: "insufficient_scope", error_description: `${scope} is required` }, {
      "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`
    })
    return false
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1")
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        return sendJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          response_modes_supported: ["query", "form_post"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: supportedScopes
        }, { "cache-control": "public, max-age=60" })
      }
      if (request.method === "GET" && url.pathname === "/jwks") {
        return sendJson(response, 200, { keys: [publicJwk] }, { "cache-control": "public, max-age=60" })
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, provider: name })
      }
      if (url.pathname === "/authorize" && request.method === "GET") {
        const input = parseAuthorize(url)
        if ("error" in input) return oauthError(response, "invalid_request", input.error)
        return sendHtml(response, 200, renderAuthorize(url, input))
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        const form = await readForm(request)
        const input = parseAuthorize(new URL(`${issuer}/authorize?${form.toString()}`))
        if ("error" in input) return oauthError(response, "invalid_request", input.error)
        const user = usersBySub.get(form.get("provider_user") ?? "")
        if (!user) return oauthError(response, "invalid_request", "Choose a valid provider user")
        return completeAuthorize(response, input, user)
      }
      if (url.pathname === "/token" && request.method === "POST") return await handleToken(request, response)
      if (url.pathname === "/userinfo" && request.method === "GET") {
        try {
          const payload = await verifyRequestToken(request, publicKey)
          const user = usersBySub.get(String(payload.sub))
          if (!user) throw new Error("Unknown user")
          return sendJson(response, 200, { sub: user.sub, name: user.name, email: user.email })
        } catch {
          return oauthError(response, "invalid_token", "A valid provider access token is required", 401)
        }
      }
      if (url.pathname === "/api/v1/metrics") {
        if (request.method !== "GET") return sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" })
        try {
          const payload = await verifyRequestToken(request, publicKey)
          if (!requireScope(response, payload, "read:metrics")) return
          counters.apiRequests += 1
          return sendJson(response, 200, {
            series: [{
              metric: "system.cpu.user",
              points: [[Math.floor(Date.now() / 1000), 0.42]],
              type: "gauge",
              host: `${name}-spike`,
              tags: ["env:dev", `provider:${name}`, `subject:${payload.sub}`]
            }],
            status: "ok"
          })
        } catch {
          return oauthError(response, "invalid_token", "A valid provider access token is required", 401)
        }
      }
      if (["/authorize", "/token", "/userinfo"].includes(url.pathname)) {
        return sendJson(response, 405, { error: "method_not_allowed" })
      }
      return sendJson(response, 404, { error: "not_found", provider: name })
    })().catch((cause: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: "server_error",
          error_description: cause instanceof Error ? cause.message : String(cause)
        })
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
    throw new Error("fake-oauth did not bind to a TCP address")
  }
  if (!issuer) {
    const hostname = address.address.includes(":") ? `[${address.address}]` : address.address
    issuer = `http://${hostname}:${address.port}`
  }

  return {
    name,
    issuer,
    port: address.port,
    authorizeUrl: `${issuer}/authorize`,
    tokenUrl: `${issuer}/token`,
    userinfoUrl: `${issuer}/userinfo`,
    apiBaseUrl: `${issuer}/api/v1`,
    jwksUrl: `${issuer}/jwks`,
    snapshot: () => ({ name, ...counters, activeRefreshTokens: refreshTokens.size }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((cause) => cause ? reject(cause) : resolve())
      server.closeIdleConnections()
    })
  }
}
