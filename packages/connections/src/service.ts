import type { Actor } from "@terrarium/auth"
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkceChallenge,
  createPkceVerifier,
  DEFAULT_REFRESH_SKEW_MS,
  exchangeAuthorizationCode,
  fetchProviderIdentity,
  OAUTH_SESSION_TTL_MS,
  OAuthTokenError,
  refreshProviderToken,
  shouldRefreshToken
} from "./oauth.ts"
import type { ConnectionRow, GrantRow } from "./schema.ts"
import type { ApprovedGrant, ConnectionsStore } from "./store.ts"

export interface AppRegistration {
  readonly id: string
  readonly secret: string
  readonly displayName?: string | undefined
}

export interface ConnectionsServiceOptions {
  readonly store: ConnectionsStore
  readonly apps: ReadonlyArray<AppRegistration>
  readonly refreshSkewMs?: number | undefined
}

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown> | undefined

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
    this.details = details
  }
}

const parseScopes = (value: unknown): ReadonlyArray<string> => {
  const scopes = Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === "string")
    : typeof value === "string"
      ? value.split(/\s+/)
      : []
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))]
}

const scopeList = (value: string) => value.split(/\s+/).filter(Boolean)

const bodyRecord = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Expected a JSON object")
  }
  return body as Record<string, unknown>
}

const requiredString = (body: Record<string, unknown>, key: string) => {
  const value = body[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_request", `${key} must be a non-empty string`)
  }
  return value.trim()
}

export const publicConnection = (connection: ConnectionRow) => ({
  connection_id: connection.id,
  user_sub: connection.userSub,
  provider: connection.provider,
  provider_account: {
    sub: connection.providerAccountSub,
    label: connection.providerAccountLabel
  },
  granted_scopes: scopeList(connection.grantedScopes),
  expires_at: connection.expiresAt === null ? null : new Date(connection.expiresAt).toISOString(),
  status: connection.status
})

export const publicGrant = (grant: GrantRow) => ({
  grant_id: grant.id,
  app_id: grant.appId,
  provider: grant.provider,
  connection_id: grant.connectionId,
  owner_sub: grant.ownerSub,
  scopes: scopeList(grant.scopes),
  status: grant.status
})

const missingScopes = (requested: string, granted: string) => {
  const available = new Set(scopeList(granted))
  return scopeList(requested).filter((scope) => !available.has(scope))
}

export class ConnectionsService {
  readonly store: ConnectionsStore
  readonly #apps: Map<string, AppRegistration>
  readonly #refreshSkewMs: number
  readonly #refreshLocks = new Map<string, Promise<void>>()
  #baseUrl = ""

  constructor(options: ConnectionsServiceOptions) {
    this.store = options.store
    this.#apps = new Map(options.apps.map((app) => [app.id, app]))
    this.#refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS
  }

  setBaseUrl(baseUrl: string): void {
    this.#baseUrl = baseUrl.replace(/\/+$/, "")
  }

  authenticateApp(authorization: string | undefined): AppRegistration {
    if (!authorization?.startsWith("Basic ")) {
      throw new HttpError(401, "invalid_app", "Expected HTTP Basic app credentials")
    }
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    const appId = separator < 0 ? decoded : decoded.slice(0, separator)
    const secret = separator < 0 ? "" : decoded.slice(separator + 1)
    const app = this.#apps.get(appId)
    if (!app || app.secret !== secret) throw new HttpError(401, "invalid_app", "Invalid app credentials")
    return app
  }

  #assertAppBody(app: AppRegistration, body: Record<string, unknown>): void {
    if (requiredString(body, "appId") !== app.id) {
      throw new HttpError(403, "app_mismatch", "Body appId does not match the authenticated app")
    }
  }

  async startConnection(actor: Actor, input: unknown) {
    const body = bodyRecord(input)
    const provider = requiredString(body, "provider")
    const client = await this.store.provider(provider)
    if (!client) throw new HttpError(404, "unknown_provider", `Unknown provider: ${provider}`)
    const requestedScopes = body.scopes === undefined
      ? scopeList(client.defaultScopes)
      : parseScopes(body.scopes)
    if (requestedScopes.length === 0) throw new HttpError(400, "invalid_scope", "At least one scope is required")
    const state = createOAuthState()
    const verifier = createPkceVerifier()
    const redirectUri = `${this.#baseUrl}/connections/callback`
    const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS
    await this.store.createOAuthSession({
      state,
      userSub: actor.sub,
      provider,
      pkceVerifier: verifier,
      redirectUri,
      requestedScopes: requestedScopes.join(" "),
      expiresAt
    })
    return {
      provider,
      authorization_url: buildAuthorizationUrl({
        client,
        redirectUri,
        state,
        codeChallenge: createPkceChallenge(verifier),
        scopes: requestedScopes.join(" ")
      }),
      state,
      expires_at: new Date(expiresAt).toISOString()
    }
  }

  async completeConnection(params: URLSearchParams) {
    const providerError = params.get("error")
    if (providerError) throw new HttpError(400, "provider_authorization_failed", providerError)
    const state = params.get("state")
    const code = params.get("code")
    if (!state || !code) throw new HttpError(400, "invalid_callback", "code and state are required")
    const session = await this.store.takeOAuthSession(state)
    if (!session || session.expiresAt <= Date.now()) {
      throw new HttpError(400, "invalid_state", "OAuth state is invalid, expired, or already used")
    }
    const client = await this.store.provider(session.provider)
    if (!client) throw new HttpError(400, "unknown_provider", "OAuth client registration disappeared")
    let token
    try {
      token = await exchangeAuthorizationCode(client, session, code)
    } catch (error) {
      if (error instanceof OAuthTokenError) {
        throw new HttpError(400, "authorization_code_exchange_failed", error.message)
      }
      throw error
    }
    const identity = await fetchProviderIdentity(client, token.accessToken)
    const connection = await this.store.upsertConnection({
      userSub: session.userSub,
      provider: session.provider,
      providerAccountSub: identity.sub,
      providerAccountLabel: identity.label,
      tokens: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        grantedScopes: token.grantedScopes,
        expiresAt: token.expiresAt
      }
    })
    return publicConnection(connection)
  }

  async requestGrant(app: AppRegistration, input: unknown) {
    const body = bodyRecord(input)
    this.#assertAppBody(app, body)
    const provider = requiredString(body, "provider")
    if (!await this.store.provider(provider)) {
      throw new HttpError(404, "unknown_provider", `Unknown provider: ${provider}`)
    }
    const scopes = parseScopes(body.scopes)
    if (scopes.length === 0) throw new HttpError(400, "invalid_scope", "At least one scope is required")
    const grant = await this.store.createGrantRequest({ appId: app.id, provider, scopes: scopes.join(" ") })
    return {
      ...publicGrant(grant),
      consent_url: `${this.#baseUrl}/grants/consent?grant=${encodeURIComponent(grant.id)}`,
      expires_at: new Date(grant.createdAt.getTime() + OAUTH_SESSION_TTL_MS).toISOString()
    }
  }

  async consent(actor: Actor, grantId: string) {
    const grant = await this.store.grant(grantId)
    if (!grant || grant.status !== "pending") {
      throw new HttpError(404, "grant_request_not_found", "Grant request is invalid or already decided")
    }
    if (grant.createdAt.getTime() + OAUTH_SESSION_TTL_MS <= Date.now()) {
      await this.store.denyGrant(grant.id)
      throw new HttpError(410, "grant_request_expired", "Grant request expired")
    }
    const client = await this.store.provider(grant.provider)
    if (!client) throw new HttpError(404, "unknown_provider", "Provider registration disappeared")
    const connection = await this.store.connectionForUser(actor.sub, grant.provider)
    if (!connection || connection.status !== "active") {
      throw new HttpError(409, "connection_required", `Connect ${client.displayName} before approving this grant`)
    }
    const missing = missingScopes(grant.scopes, connection.grantedScopes)
    if (missing.length > 0) {
      throw new HttpError(409, "missing_scopes", "The connection needs provider re-consent", { missing_scopes: missing })
    }
    return { grant, client, connection, actor }
  }

  async decideGrant(actor: Actor, input: unknown) {
    const body = bodyRecord(input)
    const grantId = requiredString(body, "grant")
    const decision = requiredString(body, "decision")
    if (decision === "deny") {
      const grant = await this.store.grant(grantId)
      if (!grant || grant.status !== "pending") {
        throw new HttpError(404, "grant_request_not_found", "Grant request is invalid or already decided")
      }
      await this.store.denyGrant(grantId)
      return { status: "denied" as const, grant_id: grantId }
    }
    if (decision !== "approve") throw new HttpError(400, "invalid_decision", "decision must be approve or deny")
    const view = await this.consent(actor, grantId)
    const approved = await this.store.approveGrant(grantId, actor.sub, view.connection.id)
    if (!approved) throw new HttpError(409, "grant_already_decided", "Grant request was already decided")
    return { status: "approved" as const, grant: publicGrant(approved) }
  }

  async revokeGrant(actor: Actor, input: unknown) {
    const body = bodyRecord(input)
    const grantId = requiredString(body, "grantId")
    const grant = await this.store.revokeGrant(grantId, actor.sub)
    if (!grant) throw new HttpError(404, "grant_not_found", "Approved grant not found for this user")
    return publicGrant(grant)
  }

  async revokeConnection(actor: Actor, input: unknown) {
    const body = bodyRecord(input)
    const connectionId = requiredString(body, "connectionId")
    const connection = await this.store.revokeConnection(connectionId, actor.sub)
    if (!connection) throw new HttpError(404, "connection_not_found", "Connection not found for this user")
    return publicConnection(connection)
  }

  #assertGrantScopes(approved: ApprovedGrant): void {
    const missing = missingScopes(approved.grant.scopes, approved.connection.grantedScopes)
    if (missing.length > 0) {
      throw new HttpError(403, "insufficient_scope", "Provider token no longer covers the grant", {
        missing_scopes: missing
      })
    }
  }

  async #withRefreshLock<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#refreshLocks.get(connectionId) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tracked = result.then(() => undefined, () => undefined)
    this.#refreshLocks.set(connectionId, tracked)
    try {
      return await result
    } finally {
      if (this.#refreshLocks.get(connectionId) === tracked) this.#refreshLocks.delete(connectionId)
    }
  }

  async #usableToken(app: AppRegistration, provider: string) {
    const selected = await this.store.approvedGrantForApp(app.id, provider)
    if (!selected) throw new HttpError(403, "grant_required", "No approved, active grant covers this app and provider")
    this.#assertGrantScopes(selected)
    return this.#withRefreshLock(selected.connection.id, async () => {
      const approved = await this.store.approvedGrantById(selected.grant.id, app.id, provider)
      if (!approved) throw new HttpError(403, "grant_required", "Grant or connection was revoked")
      this.#assertGrantScopes(approved)
      if (!shouldRefreshToken(approved.connection.expiresAt, this.#refreshSkewMs)) {
        return {
          approved,
          accessToken: this.store.openToken(approved.connection.accessToken),
          expiresAt: approved.connection.expiresAt,
          refreshed: false
        }
      }
      if (!approved.connection.refreshToken) {
        await this.store.requireReauthentication(approved.connection.id)
        throw new HttpError(403, "connection_requires_reauth", "Provider access expired without a refresh token")
      }
      let refreshed
      try {
        refreshed = await refreshProviderToken(
          approved.client,
          this.store.openToken(approved.connection.refreshToken),
          approved.connection.grantedScopes
        )
      } catch (error) {
        if (error instanceof OAuthTokenError && error.oauthError === "invalid_grant") {
          await this.store.requireReauthentication(approved.connection.id)
          throw new HttpError(403, "connection_requires_reauth", "Provider revoked the refresh token")
        }
        if (error instanceof OAuthTokenError) {
          throw new HttpError(502, "provider_refresh_failed", error.message)
        }
        throw new HttpError(502, "provider_refresh_failed", "Could not reach the provider token endpoint")
      }
      const connection = await this.store.updateConnectionTokens(approved.connection.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        grantedScopes: refreshed.grantedScopes,
        expiresAt: refreshed.expiresAt
      })
      const updated = { ...approved, connection }
      this.#assertGrantScopes(updated)
      return {
        approved: updated,
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        refreshed: true
      }
    })
  }

  async vend(app: AppRegistration, input: unknown) {
    const body = bodyRecord(input)
    this.#assertAppBody(app, body)
    const provider = requiredString(body, "provider")
    const usable = await this.#usableToken(app, provider)
    return {
      access_token: usable.accessToken,
      token_type: "Bearer",
      expires_at: usable.expiresAt === null ? null : new Date(usable.expiresAt).toISOString(),
      expires_in: usable.expiresAt === null ? null : Math.max(0, Math.floor((usable.expiresAt - Date.now()) / 1000)),
      scope: usable.approved.connection.grantedScopes,
      grant_id: usable.approved.grant.id,
      provider,
      refreshed: usable.refreshed
    }
  }

  async proxy(input: {
    readonly app: AppRegistration
    readonly provider: string
    readonly path: string
    readonly query: string
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: ArrayBuffer
  }): Promise<Response> {
    const usable = await this.#usableToken(input.app, input.provider)
    const base = new URL(`${usable.approved.client.apiBaseUrl.replace(/\/+$/, "")}/`)
    const target = new URL(input.path.replace(/^\/+/, ""), base)
    target.search = input.query
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`
    if (target.origin !== base.origin || !(target.pathname === base.pathname.replace(/\/$/, "") || target.pathname.startsWith(basePath))) {
      throw new HttpError(400, "invalid_proxy_path", "Proxy path escapes the registered provider API")
    }
    const headers = new Headers()
    const skipped = new Set([
      "authorization", "proxy-authorization", "cookie", "host", "connection", "content-length",
      "transfer-encoding", "te", "trailer", "upgrade", "x-app-id", "x-app-secret"
    ])
    for (const [name, value] of Object.entries(input.headers)) {
      if (!skipped.has(name.toLowerCase())) headers.set(name, value)
    }
    headers.set("authorization", `Bearer ${usable.accessToken}`)
    let upstream: Response
    try {
      upstream = await fetch(target, {
        method: input.method,
        headers,
        ...input.method === "GET" || input.method === "HEAD" || input.body.byteLength === 0 ? {} : { body: input.body },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      throw new HttpError(502, "provider_unavailable", "Could not reach the provider API")
    }
    const responseHeaders = new Headers(upstream.headers)
    for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"]) {
      responseHeaders.delete(name)
    }
    responseHeaders.set("cache-control", "no-store")
    responseHeaders.set("x-terrarium-grant-id", usable.approved.grant.id)
    responseHeaders.set("x-terrarium-token-refreshed", String(usable.refreshed))
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    })
  }
}

