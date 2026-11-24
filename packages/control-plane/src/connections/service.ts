import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as Schema from "effect/Schema";
import { Database } from "../store/database.ts";
import {
  connectionGrants,
  connections,
  oauthProviders,
  oauthSessions,
  proxyAudit,
  type ConnectionGrantRow,
  type ConnectionRow,
  type OAuthProviderRow,
  type OAuthSessionRow,
} from "../store/schema.ts";
import { SecretsProvider } from "../integrations/secrets.ts";
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
  shouldRefreshToken,
} from "./oauth.ts";

export class ConnectionError extends Schema.TaggedError<ConnectionError>()("ConnectionError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export interface ProviderManifestEntry {
  readonly name: string;
  readonly displayName: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly userinfoUrl: string;
  readonly apiBaseUrl: string;
  /** SecretsProvider reference holding the OAuth client id (env var name locally, SM name in prod). */
  readonly clientIdRef: string;
  /** SecretsProvider reference holding the OAuth client secret. */
  readonly clientSecretRef: string;
  readonly defaultScopes: ReadonlyArray<string>;
  readonly responseMode?: "query" | "form_post" | undefined;
  /**
   * Separator used when joining scopes into the authorize URL's `scope` param
   * (default " "). Linear wants comma-separated; the token response is always
   * normalized back to space-separated for storage.
   */
  readonly scopeSeparator?: string | undefined;
  /**
   * Extra query params on the authorize URL (e.g. Linear's `actor`).
   */
  readonly authorizeParams?: Readonly<Record<string, string>> | undefined;
  /**
   * Provider-specific identity fetch. Default: GET userinfoUrl with a bearer
   * token and read OIDC/GitHub-shaped fields. Linear's identity is GraphQL.
   */
  readonly fetchIdentity?: ((accessToken: string) => Promise<{ readonly sub: string; readonly label: string }>) | undefined;
}

export interface ProxyCallInput {
  readonly appId: string;
  readonly callerKind: "user" | "app";
  readonly caller: string;
  readonly provider: string;
  readonly path: string;
  readonly query: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ProxyOutcome {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

const scopeList = (value: string) => value.split(/\s+/).filter(Boolean);

export const publicConnection = (connection: ConnectionRow) => ({
  connection_id: connection.id,
  user_sub: connection.userSub,
  provider: connection.provider,
  provider_account: {
    sub: connection.providerAccountSub,
    label: connection.providerAccountLabel,
  },
  granted_scopes: scopeList(connection.grantedScopes),
  expires_at: connection.expiresAt === null ? null : new Date(connection.expiresAt).toISOString(),
  status: connection.status,
});

export const publicGrant = (grant: ConnectionGrantRow) => ({
  grant_id: grant.id,
  app_id: grant.appId,
  provider: grant.provider,
  connection_id: grant.connectionId,
  owner_sub: grant.ownerSub,
  scopes: scopeList(grant.scopes),
  status: grant.status,
  created_at: grant.createdAt,
});

const missingScopes = (requested: string, granted: string) => {
  const available = new Set(scopeList(granted));
  return scopeList(requested).filter((scope) => !available.has(scope));
};

/** AES-256-GCM at rest (v1:<iv>:<tag>:<ciphertext>, base64url) — same envelope as the spike. */
class TokenCipher {
  readonly #key: Buffer | undefined;

  constructor(secret: string | undefined) {
    this.#key = secret === undefined ? undefined : createHash("sha256").update(secret).digest();
  }

  seal(value: string): string {
    if (this.#key === undefined) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
  }

  open(value: string): string {
    if (this.#key === undefined || !value.startsWith("v1:")) return value;
    const [, iv, tag, encrypted] = value.split(":");
    if (iv === undefined || tag === undefined || encrypted === undefined) {
      throw new Error("Invalid encrypted token record");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }
}

interface ApprovedGrant {
  readonly grant: ConnectionGrantRow;
  readonly connection: ConnectionRow;
  readonly provider: OAuthProviderRow;
}

interface UsableToken {
  readonly approved: ApprovedGrant;
  readonly accessToken: string;
  readonly expiresAt: number | null;
  readonly refreshed: boolean;
}

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  Effect.fail(new ConnectionError({ status, code, message, ...(details === undefined ? {} : { details }) }));

/**
 * Per-provider behavior that can't be a DB row (functions + wire quirks).
 * Keyed by provider name, populated by registerProvider from the manifest.
 */
interface ProviderHooks {
  readonly scopeSeparator: string;
  readonly authorizeParams: Readonly<Record<string, string>>;
  readonly fetchIdentity?: ((accessToken: string) => Promise<{ readonly sub: string; readonly label: string }>) | undefined;
}
const manifestHooks = new Map<string, ProviderHooks>();

export class Connections extends Context.Service<Connections, {
  readonly registerProvider: (entry: ProviderManifestEntry) => Effect.Effect<void, ConnectionError>;
  readonly listProviders: () => Effect.Effect<ReadonlyArray<{
    readonly name: string;
    readonly displayName: string;
    readonly defaultScopes: ReadonlyArray<string>;
    readonly configured: boolean;
  }>>;
  readonly startConnection: (
    userSub: string,
    provider: string,
    scopes: ReadonlyArray<string> | undefined,
  ) => Effect.Effect<{
    readonly provider: string;
    readonly authorization_url: string;
    readonly state: string;
    readonly expires_at: string;
  }, ConnectionError>;
  readonly completeConnection: (params: URLSearchParams) => Effect.Effect<ReturnType<typeof publicConnection>, ConnectionError>;
  readonly listConnections: (userSub: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof publicConnection>>>;
  readonly requestGrant: (
    appId: string,
    provider: string,
    scopes: ReadonlyArray<string>,
  ) => Effect.Effect<ReturnType<typeof publicGrant> & { readonly consent_url: string; readonly expires_at: string }, ConnectionError>;
  readonly consentView: (userSub: string, grantId: string) => Effect.Effect<{
    readonly grant: ConnectionGrantRow;
    readonly provider: OAuthProviderRow;
    readonly connection: ConnectionRow;
  }, ConnectionError>;
  readonly decideGrant: (userSub: string, grantId: string, decision: "approve" | "deny") => Effect.Effect<
    | { readonly status: "approved"; readonly grant: ReturnType<typeof publicGrant> }
    | { readonly status: "denied"; readonly grant_id: string },
    ConnectionError
  >;
  readonly listGrants: (filter: {
    readonly ownerSub?: string | undefined;
    readonly appId?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<ReturnType<typeof publicGrant>>>;
  readonly revokeGrant: (userSub: string, grantId: string) => Effect.Effect<ReturnType<typeof publicGrant>, ConnectionError>;
  readonly revokeConnection: (userSub: string, connectionId: string) => Effect.Effect<ReturnType<typeof publicConnection>, ConnectionError>;
  readonly vend: (appId: string, provider: string) => Effect.Effect<{
    readonly access_token: string;
    readonly token_type: "Bearer";
    readonly expires_at: string | null;
    readonly expires_in: number | null;
    readonly scope: string;
    readonly grant_id: string;
    readonly provider: string;
    readonly refreshed: boolean;
  }, ConnectionError>;
  readonly proxy: (call: ProxyCallInput) => Effect.Effect<ProxyOutcome>;
  /** True when the name is a registered provider (used by the unified /proxy to dispatch). */
  readonly isProvider: (name: string) => Effect.Effect<boolean>;
  readonly audit: (provider: string | undefined, limit: number) => Effect.Effect<ReadonlyArray<typeof proxyAudit.$inferSelect>>;
}>()("@vibevarium/control-plane/connections/Connections") {
  static readonly layer = (options: {
    readonly baseUrl: string;
    readonly refreshSkewMs?: number | undefined;
  }) =>
    Layer.effect(Connections)(Effect.gen(function*() {
      const { db } = yield* Database;
      const secrets = yield* SecretsProvider;
      const baseUrl = options.baseUrl.replace(/\/+$/, "");
      const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

      // Token-at-rest encryption key resolved through the SecretsProvider seam:
      // env var locally, Secrets Manager in prod. Unset → plaintext (dev only,
      // surfaced loudly at boot).
      const cipherKey = yield* secrets.resolve("CONNECTIONS_TOKEN_ENCRYPTION_KEY").pipe(Effect.map(Option.getOrUndefined));
      if (cipherKey === undefined) {
        yield* Effect.logWarning("[connections] CONNECTIONS_TOKEN_ENCRYPTION_KEY is unset — provider tokens are stored UNENCRYPTED (dev only)");
      }
      const cipher = new TokenCipher(cipherKey);

      // Per-connection refresh serialization: two concurrent vends must not
      // rotate the same refresh token twice (rotation invalidates the first).
      // One shared permit per connection id — every holder of the key waits.
      const refreshLocks = yield* PartitionedSemaphore.make<string>({ permits: 1 });
      const withRefreshLock = <A, E>(connectionId: string, work: Effect.Effect<A, E>) =>
        PartitionedSemaphore.withPermit(refreshLocks, connectionId)(work);

      const providerRow = Effect.fnUntraced(function*(name: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(oauthProviders).where(eq(oauthProviders.name, name)).limit(1)
        );
        return Option.fromUndefinedOr(rows[0]);
      });

      const resolveClientCredentials = Effect.fnUntraced(function*(row: OAuthProviderRow) {
        const clientId = yield* secrets.resolve(row.clientIdRef);
        const clientSecret = yield* secrets.resolve(row.clientSecretRef);
        if (Option.isNone(clientId) || Option.isNone(clientSecret)) {
          return yield* fail(503, "provider_not_configured",
            `Provider ${row.name} has no OAuth client credentials (refs ${row.clientIdRef} / ${row.clientSecretRef})`);
        }
        return { clientId: clientId.value, clientSecret: clientSecret.value };
      });

      const registerProvider = Effect.fnUntraced(function*(entry: ProviderManifestEntry) {
        const values = {
          name: entry.name,
          displayName: entry.displayName,
          authorizeUrl: entry.authorizeUrl,
          tokenUrl: entry.tokenUrl,
          userinfoUrl: entry.userinfoUrl,
          apiBaseUrl: entry.apiBaseUrl.replace(/\/+$/, ""),
          clientIdRef: entry.clientIdRef,
          clientSecretRef: entry.clientSecretRef,
          defaultScopes: entry.defaultScopes.join(" "),
          responseMode: entry.responseMode ?? "query",
          updatedAt: new Date().toISOString(),
        };
        yield* Effect.promise(() =>
          db.insert(oauthProviders).values(values).onConflictDoUpdate({ target: oauthProviders.name, set: values })
        );
        manifestHooks.set(entry.name, {
          scopeSeparator: entry.scopeSeparator ?? " ",
          authorizeParams: entry.authorizeParams ?? {},
          ...(entry.fetchIdentity === undefined ? {} : { fetchIdentity: entry.fetchIdentity }),
        });
      });

      const listProviders = Effect.fnUntraced(function*() {
        const rows = yield* Effect.promise(() => db.select().from(oauthProviders));
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(secrets.resolve(row.clientSecretRef), (secret) => ({
            name: row.name,
            displayName: row.displayName,
            defaultScopes: scopeList(row.defaultScopes),
            configured: Option.isSome(secret),
          }))
        );
      });

      const startConnection = Effect.fnUntraced(function*(
        userSub: string,
        provider: string,
        scopes: ReadonlyArray<string> | undefined,
      ) {
        const row = yield* providerRow(provider);
        if (Option.isNone(row)) return yield* fail(404, "unknown_provider", `Unknown provider: ${provider}`);
        const creds = yield* resolveClientCredentials(row.value);
        const requestedScopes = scopes === undefined || scopes.length === 0
          ? scopeList(row.value.defaultScopes)
          : [...new Set(scopes)];
        if (requestedScopes.length === 0) return yield* fail(400, "invalid_scope", "At least one scope is required");
        const state = createOAuthState();
        const verifier = createPkceVerifier();
        const redirectUri = `${baseUrl}/connections/callback`;
        const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;
        yield* Effect.promise(() =>
          db.delete(oauthSessions).where(and(
            eq(oauthSessions.userSub, userSub),
            lt(oauthSessions.expiresAt, Date.now()),
          ))
        );
        yield* Effect.promise(() =>
          db.insert(oauthSessions).values({
            state,
            userSub,
            provider,
            pkceVerifier: verifier,
            redirectUri,
            requestedScopes: requestedScopes.join(" "),
            expiresAt,
          })
        );
        return {
          provider,
          authorization_url: buildAuthorizationUrl({
            provider: row.value,
            clientId: creds.clientId,
            redirectUri,
            state,
            codeChallenge: createPkceChallenge(verifier),
            scopes: requestedScopes.join(manifestHooks.get(provider)?.scopeSeparator ?? " "),
            extraParams: manifestHooks.get(provider)?.authorizeParams ?? {},
          }),
          state,
          expires_at: new Date(expiresAt).toISOString(),
        };
      });

      const completeConnection = Effect.fnUntraced(function*(params: URLSearchParams) {
        const providerError = params.get("error");
        if (providerError !== null) return yield* fail(400, "provider_authorization_failed", providerError);
        const state = params.get("state");
        const code = params.get("code");
        if (state === null || code === null) return yield* fail(400, "invalid_callback", "code and state are required");
        const taken = yield* Effect.promise(() =>
          db.delete(oauthSessions).where(eq(oauthSessions.state, state)).returning()
        );
        const session = taken[0] as OAuthSessionRow | undefined;
        if (session === undefined || session.expiresAt <= Date.now()) {
          return yield* fail(400, "invalid_state", "OAuth state is invalid, expired, or already used");
        }
        const row = yield* providerRow(session.provider);
        if (Option.isNone(row)) return yield* fail(400, "unknown_provider", "Provider registration disappeared");
        const creds = yield* resolveClientCredentials(row.value);
        const token = yield* Effect.tryPromise({
          try: () => exchangeAuthorizationCode(row.value, creds.clientId, creds.clientSecret, session, code),
          catch: (cause) =>
            cause instanceof OAuthTokenError
              ? new ConnectionError({ status: 400, code: "authorization_code_exchange_failed", message: cause.message })
              : new ConnectionError({ status: 502, code: "provider_unreachable", message: "Could not reach the provider token endpoint" }),
        });
        const identityFetch = manifestHooks.get(session.provider)?.fetchIdentity;
        const identity = yield* Effect.tryPromise({
          try: () => identityFetch === undefined
            ? fetchProviderIdentity(row.value, token.accessToken)
            : identityFetch(token.accessToken),
          catch: (cause) => new ConnectionError({
            status: 502,
            code: "provider_identity_failed",
            message: cause instanceof Error ? cause.message : "userinfo failed",
          }),
        });
        const values = {
          userSub: session.userSub,
          provider: session.provider,
          providerAccountSub: identity.sub,
          providerAccountLabel: identity.label,
          accessToken: cipher.seal(token.accessToken),
          refreshToken: token.refreshToken === null ? null : cipher.seal(token.refreshToken),
          grantedScopes: token.grantedScopes,
          expiresAt: token.expiresAt,
          status: "active",
          updatedAt: new Date().toISOString(),
        };
        const saved = yield* Effect.promise(() =>
          db.insert(connections).values({ id: randomUUID(), ...values }).onConflictDoUpdate({
            target: [connections.userSub, connections.provider],
            set: values,
          }).returning()
        );
        const connection = saved[0];
        if (connection === undefined) return yield* fail(500, "internal_error", "Failed to save the connection");
        return publicConnection(connection);
      });

      const listConnections = Effect.fnUntraced(function*(userSub: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(connections).where(eq(connections.userSub, userSub)).orderBy(desc(connections.updatedAt))
        );
        return rows.map(publicConnection);
      });

      const requestGrant = Effect.fnUntraced(function*(appId: string, provider: string, scopes: ReadonlyArray<string>) {
        const row = yield* providerRow(provider);
        if (Option.isNone(row)) return yield* fail(404, "unknown_provider", `Unknown provider: ${provider}`);
        const deduped = [...new Set(scopes)];
        if (deduped.length === 0) return yield* fail(400, "invalid_scope", "At least one scope is required");
        const inserted = yield* Effect.promise(() =>
          db.insert(connectionGrants).values({ id: randomUUID(), appId, provider, scopes: deduped.join(" ") }).returning()
        );
        const grant = inserted[0];
        if (grant === undefined) return yield* fail(500, "internal_error", "Failed to create the grant request");
        return {
          ...publicGrant(grant),
          consent_url: `${baseUrl}/grants/consent?grant=${encodeURIComponent(grant.id)}`,
          expires_at: new Date(new Date(grant.createdAt).getTime() + OAUTH_SESSION_TTL_MS).toISOString(),
        };
      });

      const consentView = Effect.fnUntraced(function*(userSub: string, grantId: string) {
        const rows = yield* Effect.promise(() =>
          db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId)).limit(1)
        );
        const grant = rows[0];
        if (grant === undefined || grant.status !== "pending") {
          return yield* fail(404, "grant_request_not_found", "Grant request is invalid or already decided");
        }
        if (new Date(grant.createdAt).getTime() + OAUTH_SESSION_TTL_MS <= Date.now()) {
          yield* Effect.promise(() =>
            db.delete(connectionGrants).where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.status, "pending")))
          );
          return yield* fail(410, "grant_request_expired", "Grant request expired");
        }
        const provider = yield* providerRow(grant.provider);
        if (Option.isNone(provider)) return yield* fail(404, "unknown_provider", "Provider registration disappeared");
        const userConnections = yield* Effect.promise(() =>
          db.select().from(connections).where(and(
            eq(connections.userSub, userSub),
            eq(connections.provider, grant.provider),
          )).limit(1)
        );
        const connection = userConnections[0];
        if (connection === undefined || connection.status !== "active") {
          return yield* fail(409, "connection_required",
            `Connect ${provider.value.displayName} before approving this grant`, {
              connect_url: `${baseUrl}/connections/start`,
              provider: grant.provider,
            });
        }
        const missing = missingScopes(grant.scopes, connection.grantedScopes);
        if (missing.length > 0) {
          return yield* fail(409, "missing_scopes", "The connection needs provider re-consent", { missing_scopes: missing });
        }
        return { grant, provider: provider.value, connection };
      });

      const decideGrant = Effect.fnUntraced(function*(userSub: string, grantId: string, decision: "approve" | "deny") {
        if (decision === "deny") {
          const deleted = yield* Effect.promise(() =>
            db.delete(connectionGrants).where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.status, "pending"))).returning()
          );
          if (deleted[0] === undefined) {
            return yield* fail(404, "grant_request_not_found", "Grant request is invalid or already decided");
          }
          return { status: "denied" as const, grant_id: grantId };
        }
        const view = yield* consentView(userSub, grantId);
        // Bind the request to the approver's connection. Exactly one usable
        // grant per (app, provider): earlier approved rows are superseded.
        const approved = yield* Effect.promise(() =>
          db.transaction(async (tx) => {
            const pending = await tx.select().from(connectionGrants)
              .where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.status, "pending"))).limit(1);
            if (pending[0] === undefined) return undefined;
            const now = new Date().toISOString();
            await tx.update(connectionGrants).set({ status: "revoked", updatedAt: now })
              .where(and(
                eq(connectionGrants.appId, pending[0].appId),
                eq(connectionGrants.provider, pending[0].provider),
                eq(connectionGrants.status, "approved"),
              ));
            const rows = await tx.update(connectionGrants).set({
              ownerSub: userSub,
              connectionId: view.connection.id,
              status: "approved",
              approvedAt: now,
              updatedAt: now,
            }).where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.status, "pending"))).returning();
            return rows[0];
          })
        );
        if (approved === undefined) {
          return yield* fail(409, "grant_already_decided", "Grant request was already decided");
        }
        return { status: "approved" as const, grant: publicGrant(approved) };
      });

      const listGrants = Effect.fnUntraced(function*(filter: {
        readonly ownerSub?: string | undefined;
        readonly appId?: string | undefined;
      }) {
        const conditions: Array<SQL> = [];
        if (filter.ownerSub !== undefined) conditions.push(eq(connectionGrants.ownerSub, filter.ownerSub));
        if (filter.appId !== undefined) conditions.push(eq(connectionGrants.appId, filter.appId));
        const rows = yield* Effect.promise(() =>
          conditions.length === 0
            ? db.select().from(connectionGrants).orderBy(desc(connectionGrants.updatedAt))
            : db.select().from(connectionGrants).where(and(...conditions)).orderBy(desc(connectionGrants.updatedAt))
        );
        return rows.map(publicGrant);
      });

      const revokeGrant = Effect.fnUntraced(function*(userSub: string, grantId: string) {
        const rows = yield* Effect.promise(() =>
          db.update(connectionGrants).set({ status: "revoked", updatedAt: new Date().toISOString() })
            .where(and(
              eq(connectionGrants.id, grantId),
              eq(connectionGrants.ownerSub, userSub),
              eq(connectionGrants.status, "approved"),
            )).returning()
        );
        const grant = rows[0];
        if (grant === undefined) {
          return yield* fail(404, "grant_not_found", "Approved grant not found for this user");
        }
        return publicGrant(grant);
      });

      const revokeConnection = Effect.fnUntraced(function*(userSub: string, connectionId: string) {
        const revoked = yield* Effect.promise(() =>
          db.transaction(async (tx) => {
            const rows = await tx.update(connections).set({ status: "revoked", updatedAt: new Date().toISOString() })
              .where(and(eq(connections.id, connectionId), eq(connections.userSub, userSub)))
              .returning();
            if (rows[0] !== undefined) {
              await tx.update(connectionGrants).set({ status: "revoked", updatedAt: new Date().toISOString() })
                .where(eq(connectionGrants.connectionId, connectionId));
            }
            return rows[0];
          })
        );
        if (revoked === undefined) {
          return yield* fail(404, "connection_not_found", "Connection not found for this user");
        }
        return publicConnection(revoked);
      });

      const assertGrantScopes = (selected: ApprovedGrant): Effect.Effect<void, ConnectionError> => {
        const missing = missingScopes(selected.grant.scopes, selected.connection.grantedScopes);
        return missing.length > 0
          ? fail(403, "insufficient_scope", "Provider token no longer covers the grant", { missing_scopes: missing })
          : Effect.void;
      };

      const approvedGrantForApp = (appId: string, provider: string) =>
        Effect.promise(() =>
          db.select({ grant: connectionGrants, connection: connections, provider: oauthProviders })
            .from(connectionGrants)
            .innerJoin(connections, eq(connectionGrants.connectionId, connections.id))
            .innerJoin(oauthProviders, eq(connectionGrants.provider, oauthProviders.name))
            .where(and(
              eq(connectionGrants.appId, appId),
              eq(connectionGrants.provider, provider),
              eq(connectionGrants.status, "approved"),
              eq(connections.status, "active"),
            ))
            .orderBy(desc(connectionGrants.updatedAt))
            .limit(1)
            .then((rows) => rows[0] as ApprovedGrant | undefined)
        );

      const approvedGrantById = (grantId: string, appId: string, provider: string) =>
        Effect.promise(() =>
          db.select({ grant: connectionGrants, connection: connections, provider: oauthProviders })
            .from(connectionGrants)
            .innerJoin(connections, eq(connectionGrants.connectionId, connections.id))
            .innerJoin(oauthProviders, eq(connectionGrants.provider, oauthProviders.name))
            .where(and(
              eq(connectionGrants.id, grantId),
              eq(connectionGrants.appId, appId),
              eq(connectionGrants.provider, provider),
              eq(connectionGrants.status, "approved"),
              eq(connections.status, "active"),
            ))
            .limit(1)
            .then((rows) => rows[0] as ApprovedGrant | undefined)
        );

      const requireReauthentication = (connectionId: string) =>
        Effect.promise(() =>
          db.transaction(async (tx) => {
            await tx.update(connections).set({ status: "requires_reauth", updatedAt: new Date().toISOString() })
              .where(eq(connections.id, connectionId));
            await tx.update(connectionGrants).set({ status: "revoked", updatedAt: new Date().toISOString() })
              .where(eq(connectionGrants.connectionId, connectionId));
          })
        );

      const usableToken = (appId: string, provider: string): Effect.Effect<UsableToken, ConnectionError> =>
        Effect.gen(function*() {
          const selected = yield* approvedGrantForApp(appId, provider);
          if (selected === undefined) {
            return yield* fail(403, "grant_required", "No approved, active grant covers this app and provider");
          }
          yield* assertGrantScopes(selected);
          return yield* withRefreshLock(selected.connection.id, Effect.gen(function*() {
            // Re-read inside the lock: a concurrent refresh may have updated
            // tokens, or the grant/connection may have been revoked.
            const approved = yield* approvedGrantById(selected.grant.id, appId, provider);
            if (approved === undefined) {
              return yield* fail(403, "grant_required", "Grant or connection was revoked");
            }
            yield* assertGrantScopes(approved);
            if (!shouldRefreshToken(approved.connection.expiresAt, refreshSkewMs)) {
              return {
                approved,
                accessToken: cipher.open(approved.connection.accessToken),
                expiresAt: approved.connection.expiresAt,
                refreshed: false,
              } satisfies UsableToken;
            }
            if (approved.connection.refreshToken === null) {
              yield* requireReauthentication(approved.connection.id);
              return yield* fail(403, "connection_requires_reauth", "Provider access expired without a refresh token");
            }
            const refreshToken = approved.connection.refreshToken;
            const creds = yield* resolveClientCredentials(approved.provider);
            const refreshed = yield* Effect.tryPromise({
              try: () => refreshProviderToken(
                approved.provider,
                creds.clientId,
                creds.clientSecret,
                cipher.open(refreshToken),
                approved.connection.grantedScopes,
              ),
              catch: (cause) =>
                cause instanceof OAuthTokenError
                  ? new ConnectionError({
                      status: cause.oauthError === "invalid_grant" ? 403 : 502,
                      code: cause.oauthError === "invalid_grant" ? "connection_requires_reauth" : "provider_refresh_failed",
                      message: cause.oauthError === "invalid_grant" ? "Provider revoked the refresh token" : cause.message,
                    })
                  : new ConnectionError({ status: 502, code: "provider_refresh_failed", message: "Could not reach the provider token endpoint" }),
            }).pipe(Effect.tapError((error) =>
              error.code === "connection_requires_reauth" ? requireReauthentication(approved.connection.id) : Effect.void
            ));
            const now = new Date().toISOString();
            const updatedRows = yield* Effect.promise(() =>
              db.update(connections).set({
                accessToken: cipher.seal(refreshed.accessToken),
                refreshToken: refreshed.refreshToken === null ? null : cipher.seal(refreshed.refreshToken),
                grantedScopes: refreshed.grantedScopes,
                expiresAt: refreshed.expiresAt,
                status: "active",
                updatedAt: now,
              }).where(eq(connections.id, approved.connection.id)).returning()
            );
            const updated = updatedRows[0];
            if (updated === undefined) {
              return yield* fail(403, "grant_required", "Connection disappeared during token refresh");
            }
            const next = { ...approved, connection: updated };
            yield* assertGrantScopes(next);
            return {
              approved: next,
              accessToken: refreshed.accessToken,
              expiresAt: refreshed.expiresAt,
              refreshed: true,
            } satisfies UsableToken;
          }));
        });

      const vend = Effect.fnUntraced(function*(appId: string, provider: string) {
        const usable = yield* usableToken(appId, provider);
        return {
          access_token: usable.accessToken,
          token_type: "Bearer" as const,
          expires_at: usable.expiresAt === null ? null : new Date(usable.expiresAt).toISOString(),
          expires_in: usable.expiresAt === null ? null : Math.max(0, Math.floor((usable.expiresAt - Date.now()) / 1000)),
          scope: usable.approved.connection.grantedScopes,
          grant_id: usable.approved.grant.id,
          provider,
          refreshed: usable.refreshed,
        };
      });

      const recordAudit = (call: ProxyCallInput, status: string, durationMs: number) =>
        Effect.promise(() =>
          db.insert(proxyAudit).values({
            id: randomUUID(),
            callerKind: call.callerKind,
            caller: call.caller,
            app: call.appId,
            // One audit table: provider connections and platform integrations
            // share the `integration` column.
            integration: call.provider,
            method: call.method,
            path: call.path,
            status,
            durationMs: String(durationMs),
          })
        ).pipe(Effect.ignore);

      const auditRows = Effect.fnUntraced(function*(provider: string | undefined, limit: number) {
        const base = db.select().from(proxyAudit).orderBy(desc(proxyAudit.at)).limit(limit);
        return yield* Effect.promise(() =>
          provider === undefined ? base : base.where(eq(proxyAudit.integration, provider))
        );
      });

      const forwardToProvider = Effect.fnUntraced(function*(call: ProxyCallInput, usable: UsableToken, started: number) {
        const base = new URL(`${usable.approved.provider.apiBaseUrl.replace(/\/+$/, "")}/`);
        const target = new URL(call.path.replace(/^\/+/, ""), base);
        target.search = call.query;
        const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
        if (target.origin !== base.origin ||
            !(target.pathname === base.pathname.replace(/\/$/, "") || target.pathname.startsWith(basePath))) {
          return {
            status: 400,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: new TextEncoder().encode(JSON.stringify({
              error: "invalid_proxy_path",
              error_description: "Proxy path escapes the registered provider API",
            })),
          } satisfies ProxyOutcome;
        }

        const skipped = new Set([
          "authorization", "proxy-authorization", "cookie", "host", "connection", "content-length",
          "transfer-encoding", "te", "trailer", "upgrade", "x-vibevarium-app", "x-vibevarium-app-secret",
          "x-app-id", "x-app-secret", "x-vibevarium-on-behalf-of-app",
        ]);
        const headers = new Headers();
        for (const [name, value] of Object.entries(call.headers)) {
          if (!skipped.has(name.toLowerCase())) headers.set(name, value);
        }
        headers.set("authorization", `Bearer ${usable.accessToken}`);
        headers.set("user-agent", headers.get("user-agent") ?? "vibevarium-control-plane");
        const upstream = yield* Effect.tryPromise({
          try: () =>
            fetch(target, {
              method: call.method,
              headers,
              ...(call.method === "GET" || call.method === "HEAD" || call.body.byteLength === 0
                ? {}
                : { body: call.body.slice().buffer }),
              redirect: "manual",
              signal: AbortSignal.timeout(15_000),
            }),
          catch: () => "unreachable" as const,
        }).pipe(Effect.catch(() => Effect.succeed("unreachable" as const)));
        if (typeof upstream === "string") {
          yield* recordAudit(call, "502 provider_unavailable", Date.now() - started);
          return {
            status: 502,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: new TextEncoder().encode(JSON.stringify({
              error: "provider_unavailable",
              error_description: "Could not reach the provider API",
            })),
          } satisfies ProxyOutcome;
        }
        const responseHeaders = new Headers(upstream.headers);
        for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"]) {
          responseHeaders.delete(name);
        }
        responseHeaders.set("cache-control", "no-store");
        responseHeaders.set("x-vibevarium-grant-id", usable.approved.grant.id);
        responseHeaders.set("x-vibevarium-token-refreshed", String(usable.refreshed));
        const body = new Uint8Array(yield* Effect.promise(() => upstream.arrayBuffer()));
        const outHeaders: Record<string, string> = {};
        responseHeaders.forEach((value, name) => {
          outHeaders[name] = value;
        });
        yield* recordAudit(call, String(upstream.status), Date.now() - started);
        return { status: upstream.status, headers: outHeaders, body } satisfies ProxyOutcome;
      });

      const isProvider = Effect.fnUntraced(function*(name: string) {
        return Option.isSome(yield* providerRow(name));
      });

      const proxy = Effect.fnUntraced(function*(call: ProxyCallInput) {
        const started = Date.now();
        return yield* usableToken(call.appId, call.provider).pipe(
          Effect.match({
            onFailure: (error: ConnectionError) =>
              Effect.andThen(
                recordAudit(call, `${error.status} ${error.code}`, Date.now() - started),
                Effect.succeed({
                  status: error.status,
                  headers: { "content-type": "application/json; charset=utf-8" },
                  body: new TextEncoder().encode(JSON.stringify({
                    error: error.code,
                    error_description: error.message,
                    app: call.appId,
                    provider: call.provider,
                    ...error.details,
                  })),
                } satisfies ProxyOutcome),
              ),
            onSuccess: (usable) => forwardToProvider(call, usable, started),
          }),
          Effect.flatten,
        );
      });

      return Connections.of({
        registerProvider,
        listProviders,
        startConnection,
        completeConnection,
        listConnections,
        requestGrant,
        consentView,
        decideGrant,
        listGrants,
        revokeGrant,
        revokeConnection,
        vend,
        proxy,
        isProvider,
        audit: auditRows,
      });
    }));
}
