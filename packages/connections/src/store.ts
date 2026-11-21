import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { PGlite } from "@electric-sql/pglite"
import { and, desc, eq, lt } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import * as schema from "./schema.ts"
import { connections, grants, oauthClients, oauthSessions } from "./schema.ts"
import type { ConnectionRow, GrantRow, OAuthClientRow, OAuthSessionRow } from "./schema.ts"

export interface ProviderRegistration {
  readonly name: string
  readonly displayName: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly userinfoUrl: string
  readonly apiBaseUrl: string
  readonly clientId: string
  readonly clientSecret: string
  readonly defaultScopes: ReadonlyArray<string>
  readonly responseMode?: "query" | "form_post" | undefined
}

export interface ConnectionTokens {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly grantedScopes: string
  readonly expiresAt: number | null
}

export interface ApprovedGrant {
  readonly grant: GrantRow
  readonly connection: ConnectionRow
  readonly client: OAuthClientRow
}

export interface ConnectionsStoreOptions {
  readonly dataDir?: string | undefined
  readonly tokenEncryptionKey?: string | undefined
}

const schemaSql = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  name text PRIMARY KEY,
  display_name text NOT NULL,
  authorize_url text NOT NULL,
  token_url text NOT NULL,
  userinfo_url text NOT NULL,
  api_base_url text NOT NULL,
  client_id text NOT NULL,
  client_secret text NOT NULL,
  default_scopes text NOT NULL,
  response_mode text NOT NULL DEFAULT 'query',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY,
  user_sub text NOT NULL,
  provider text NOT NULL REFERENCES oauth_clients(name) ON DELETE CASCADE,
  provider_account_sub text NOT NULL,
  provider_account_label text NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  granted_scopes text NOT NULL,
  expires_at bigint,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_user_provider_unique ON connections(user_sub, provider);
CREATE INDEX IF NOT EXISTS connections_provider_status_idx ON connections(provider, status);
CREATE TABLE IF NOT EXISTS grants (
  id uuid PRIMARY KEY,
  app_id text NOT NULL,
  provider text NOT NULL REFERENCES oauth_clients(name) ON DELETE CASCADE,
  connection_id uuid REFERENCES connections(id) ON DELETE CASCADE,
  owner_sub text,
  scopes text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS grants_app_provider_status_idx ON grants(app_id, provider, status);
CREATE INDEX IF NOT EXISTS grants_connection_status_idx ON grants(connection_id, status);
CREATE TABLE IF NOT EXISTS oauth_sessions (
  state text PRIMARY KEY,
  user_sub text NOT NULL,
  provider text NOT NULL REFERENCES oauth_clients(name) ON DELETE CASCADE,
  pkce_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  requested_scopes text NOT NULL,
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_sessions_expiry_idx ON oauth_sessions(expires_at);
`

class TokenCipher {
  readonly #key: Buffer | undefined

  constructor(secret: string | undefined) {
    this.#key = secret === undefined ? undefined : createHash("sha256").update(secret).digest()
  }

  seal(value: string): string {
    if (this.#key === undefined) return value
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv)
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`
  }

  open(value: string): string {
    if (this.#key === undefined || !value.startsWith("v1:")) return value
    const [, iv, tag, encrypted] = value.split(":")
    if (!iv || !tag || !encrypted) throw new Error("Invalid encrypted token record")
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8")
  }
}

export class ConnectionsStore {
  readonly db: PgliteDatabase<typeof schema>
  readonly #client: PGlite
  readonly #cipher: TokenCipher

  private constructor(client: PGlite, cipher: TokenCipher) {
    this.#client = client
    this.#cipher = cipher
    this.db = drizzle(client, { schema })
  }

  static async open(options: ConnectionsStoreOptions = {}): Promise<ConnectionsStore> {
    const client = await PGlite.create(options.dataDir ?? "memory://")
    try {
      await client.exec(schemaSql)
      return new ConnectionsStore(client, new TokenCipher(options.tokenEncryptionKey))
    } catch (error) {
      await client.close()
      throw error
    }
  }

  sealToken(value: string): string {
    return this.#cipher.seal(value)
  }

  openToken(value: string): string {
    return this.#cipher.open(value)
  }

  async registerProvider(registration: ProviderRegistration): Promise<OAuthClientRow> {
    const values = {
      ...registration,
      defaultScopes: registration.defaultScopes.join(" "),
      responseMode: registration.responseMode ?? "query",
      updatedAt: new Date()
    }
    const [row] = await this.db.insert(oauthClients).values(values).onConflictDoUpdate({
      target: oauthClients.name,
      set: values
    }).returning()
    if (!row) throw new Error("Failed to register OAuth client")
    return row
  }

  async provider(name: string): Promise<OAuthClientRow | undefined> {
    return this.db.query.oauthClients.findFirst({ where: eq(oauthClients.name, name) })
  }

  async createOAuthSession(input: {
    readonly state: string
    readonly userSub: string
    readonly provider: string
    readonly pkceVerifier: string
    readonly redirectUri: string
    readonly requestedScopes: string
    readonly expiresAt: number
  }): Promise<void> {
    await this.db.delete(oauthSessions).where(and(
      eq(oauthSessions.userSub, input.userSub),
      lt(oauthSessions.expiresAt, Date.now())
    ))
    await this.db.insert(oauthSessions).values(input)
  }

  async takeOAuthSession(state: string): Promise<OAuthSessionRow | undefined> {
    const [row] = await this.db.delete(oauthSessions).where(eq(oauthSessions.state, state)).returning()
    return row
  }

  async upsertConnection(input: {
    readonly userSub: string
    readonly provider: string
    readonly providerAccountSub: string
    readonly providerAccountLabel: string
    readonly tokens: ConnectionTokens
  }): Promise<ConnectionRow> {
    const values = {
      userSub: input.userSub,
      provider: input.provider,
      providerAccountSub: input.providerAccountSub,
      providerAccountLabel: input.providerAccountLabel,
      accessToken: this.sealToken(input.tokens.accessToken),
      refreshToken: input.tokens.refreshToken === null ? null : this.sealToken(input.tokens.refreshToken),
      grantedScopes: input.tokens.grantedScopes,
      expiresAt: input.tokens.expiresAt,
      status: "active",
      updatedAt: new Date()
    }
    const [row] = await this.db.insert(connections).values({ id: randomUUID(), ...values }).onConflictDoUpdate({
      target: [connections.userSub, connections.provider],
      set: values
    }).returning()
    if (!row) throw new Error("Failed to save connection")
    return row
  }

  async updateConnectionTokens(connectionId: string, tokens: ConnectionTokens): Promise<ConnectionRow> {
    const [row] = await this.db.update(connections).set({
      accessToken: this.sealToken(tokens.accessToken),
      refreshToken: tokens.refreshToken === null ? null : this.sealToken(tokens.refreshToken),
      grantedScopes: tokens.grantedScopes,
      expiresAt: tokens.expiresAt,
      status: "active",
      updatedAt: new Date()
    }).where(eq(connections.id, connectionId)).returning()
    if (!row) throw new Error("Connection disappeared during token refresh")
    return row
  }

  async connectionForUser(userSub: string, provider: string): Promise<ConnectionRow | undefined> {
    return this.db.query.connections.findFirst({ where: and(
      eq(connections.userSub, userSub),
      eq(connections.provider, provider)
    ) })
  }

  async createGrantRequest(input: {
    readonly appId: string
    readonly provider: string
    readonly scopes: string
  }): Promise<GrantRow> {
    const [row] = await this.db.insert(grants).values({ id: randomUUID(), ...input }).returning()
    if (!row) throw new Error("Failed to create grant request")
    return row
  }

  async grant(id: string): Promise<GrantRow | undefined> {
    return this.db.query.grants.findFirst({ where: eq(grants.id, id) })
  }

  async approveGrant(grantId: string, ownerSub: string, connectionId: string): Promise<GrantRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [pending] = await tx.select().from(grants)
        .where(and(eq(grants.id, grantId), eq(grants.status, "pending"))).limit(1)
      if (!pending) return undefined
      // This spike has no per-user audience at vend time, so keep exactly one
      // usable grant per (app, provider) instead of silently choosing a user's.
      await tx.update(grants).set({ status: "revoked", updatedAt: new Date() })
        .where(and(eq(grants.appId, pending.appId), eq(grants.provider, pending.provider), eq(grants.status, "approved")))
      const [row] = await tx.update(grants).set({
        ownerSub,
        connectionId,
        status: "approved",
        approvedAt: new Date(),
        updatedAt: new Date()
      }).where(and(eq(grants.id, grantId), eq(grants.status, "pending"))).returning()
      return row
    })
  }

  async denyGrant(grantId: string): Promise<void> {
    await this.db.delete(grants).where(and(eq(grants.id, grantId), eq(grants.status, "pending")))
  }

  async approvedGrantForApp(appId: string, provider: string): Promise<ApprovedGrant | undefined> {
    const [row] = await this.db.select({ grant: grants, connection: connections, client: oauthClients })
      .from(grants)
      .innerJoin(connections, eq(grants.connectionId, connections.id))
      .innerJoin(oauthClients, eq(grants.provider, oauthClients.name))
      .where(and(
        eq(grants.appId, appId),
        eq(grants.provider, provider),
        eq(grants.status, "approved"),
        eq(connections.status, "active")
      ))
      .orderBy(desc(grants.updatedAt))
      .limit(1)
    return row
  }

  async approvedGrantById(grantId: string, appId: string, provider: string): Promise<ApprovedGrant | undefined> {
    const [row] = await this.db.select({ grant: grants, connection: connections, client: oauthClients })
      .from(grants)
      .innerJoin(connections, eq(grants.connectionId, connections.id))
      .innerJoin(oauthClients, eq(grants.provider, oauthClients.name))
      .where(and(
        eq(grants.id, grantId),
        eq(grants.appId, appId),
        eq(grants.provider, provider),
        eq(grants.status, "approved"),
        eq(connections.status, "active")
      ))
      .limit(1)
    return row
  }

  async revokeGrant(grantId: string, ownerSub: string): Promise<GrantRow | undefined> {
    const [row] = await this.db.update(grants).set({ status: "revoked", updatedAt: new Date() })
      .where(and(eq(grants.id, grantId), eq(grants.ownerSub, ownerSub), eq(grants.status, "approved")))
      .returning()
    return row
  }

  async revokeConnection(connectionId: string, ownerSub: string): Promise<ConnectionRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(connections).set({ status: "revoked", updatedAt: new Date() })
        .where(and(eq(connections.id, connectionId), eq(connections.userSub, ownerSub)))
        .returning()
      if (row) {
        await tx.update(grants).set({ status: "revoked", updatedAt: new Date() })
          .where(eq(grants.connectionId, connectionId))
      }
      return row
    })
  }

  async requireReauthentication(connectionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(connections).set({ status: "requires_reauth", updatedAt: new Date() })
        .where(eq(connections.id, connectionId))
      await tx.update(grants).set({ status: "revoked", updatedAt: new Date() })
        .where(eq(grants.connectionId, connectionId))
    })
  }

  async close(): Promise<void> {
    await this.#client.close()
  }
}
