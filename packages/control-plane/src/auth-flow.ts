/**
 * Authorization-code + PKCE login for the control-plane GUI against the
 * configured OIDC issuer (Casdoor by default; WorkOS AuthKit under
 * `TERRARIUM_AUTH_PROVIDER=workos`). The browser only holds an opaque, signed
 * httpOnly cookie. Sessions and pending logins are durable database rows;
 * tokens and PKCE verifiers are encrypted with SESSION_ENCRYPTION_KEY.
 *
 * The flow is provider-agnostic: authorization and token endpoints come from
 * the issuer's discovery document. Access-token expiry is independent of the
 * absolute session lifetime, and refresh tokens are rotated server-side.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as Schema from "effect/Schema";
import { SecretsProvider } from "./integrations/secrets.ts";
import { Database } from "./store/database.ts";
import {
  sessionTransactions,
  sessions,
  type SessionRow,
} from "./store/schema.ts";

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_SESSION_REFRESH_SKEW_MS = 60_000;
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;
const SESSION_ENCRYPTION_KEY_REF = "SESSION_ENCRYPTION_KEY";
const CLEANUP_BATCH_SIZE = 100;

export interface AuthFlowOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Public API origin; the OIDC redirect URI is built from this. */
  readonly baseUrl: string;
  /** Public GUI origin. Defaults to baseUrl for same-origin local development. */
  readonly guiOrigin?: string | undefined;
  /** Optional cross-subdomain cookie Domain, for example `.vibevarium.com`. */
  readonly cookieDomain?: string | undefined;
  /** RFC 8707 resource indicator for the access token. */
  readonly resource: string;
  /** Defaults to `openid profile email offline_access`. */
  readonly scope?: string | undefined;
  /** Issuer end-session path (default `/api/logout`, Casdoor's). */
  readonly endSessionPath?: string | undefined;
  /** Absolute login lifetime, independent of access-token expiry. Default seven days. */
  readonly sessionTtlMs?: number | undefined;
  /** Refresh an access token this long before its expiry. Default 60 seconds. */
  readonly refreshSkewMs?: number | undefined;
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");

export const pkcePair = () => {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

export interface Session {
  readonly sub: string;
  readonly name: string;
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken?: string | undefined;
  readonly accessTokenExpiresAt: number;
  readonly sessionExpiresAt: number;
}

interface PendingLoginInput {
  readonly verifier: string;
  readonly state: string;
  /** Optional validated local path to return to after login (default "/"). */
  readonly returnTo?: string | undefined;
}

export interface PendingLogin {
  readonly verifier: string;
  readonly stateHash: string;
  readonly returnTo?: string | undefined;
}

export class SessionRefreshError extends Schema.TaggedError<SessionRefreshError>()("SessionRefreshError", {
  message: Schema.String,
}) {}

interface GuiAuthService {
  readonly options: AuthFlowOptions;
  readonly createSession: (session: Session) => Effect.Effect<string>;
  readonly getSession: (cookieValue: string) => Effect.Effect<Session | undefined, SessionRefreshError>;
  readonly destroySession: (cookieValue: string) => Effect.Effect<void>;
  readonly rememberPending: (pending: PendingLoginInput) => Effect.Effect<string>;
  readonly takePending: (cookieValue: string) => Effect.Effect<PendingLogin | undefined>;
}

/** AES-256-GCM with a format version and stable key id in every ciphertext. */
class SessionCipher {
  readonly #key: Buffer;
  readonly #keyId: string;

  constructor(secret: string) {
    this.#key = createHmac("sha256", secret).update("vibevarium-gui-session-encryption").digest();
    this.#keyId = createHash("sha256").update(`vibevarium-gui-session-key-id:${secret}`).digest("base64url").slice(0, 16);
  }

  seal(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      "v1",
      this.#keyId,
      nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(":");
  }

  open(value: string): string {
    const [version, keyId, nonce, tag, encrypted, extra] = value.split(":");
    if (version !== "v1" || keyId !== this.#keyId || nonce === undefined || tag === undefined || encrypted === undefined || extra !== undefined) {
      throw new Error("Invalid or unsupported encrypted GUI session record");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }
}

class InvalidRefreshGrant extends Error {}
class TransientRefreshFailure extends Error {}

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const timestamp = (value: string) => new Date(value).getTime();
const iso = (value: number) => new Date(value).toISOString();
const hashState = (state: string) => createHash("sha256").update(state).digest("base64url");

export class GuiAuth extends Context.Service<GuiAuth, GuiAuthService>()("@vibevarium/control-plane/GuiAuth") {
  static readonly layer = (options: AuthFlowOptions) =>
    Layer.effect(GuiAuth)(Effect.gen(function*() {
      const { db } = yield* Database;
      const secrets = yield* SecretsProvider;
      const encryptionKey = Option.getOrUndefined(yield* secrets.resolve(SESSION_ENCRYPTION_KEY_REF));
      if (encryptionKey === undefined || encryptionKey.length === 0) {
        return yield* Effect.die(new Error(
          "SESSION_ENCRYPTION_KEY is required when control-plane GUI auth is enabled",
        ));
      }

      const cipher = new SessionCipher(encryptionKey);
      const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
      const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_SESSION_REFRESH_SKEW_MS;
      if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
        return yield* Effect.die(new Error("GUI session TTL must be a positive number of milliseconds"));
      }
      if (!Number.isFinite(refreshSkewMs) || refreshSkewMs < 0) {
        return yield* Effect.die(new Error("GUI session refresh skew must be a non-negative number of milliseconds"));
      }

      const deriveKey = (purpose: string) => createHmac("sha256", encryptionKey).update(purpose).digest();
      const sessionSigningKey = deriveKey("vibevarium-gui-session-cookie");
      const pendingSigningKey = deriveKey("vibevarium-gui-pending-cookie");
      const lookupKey = deriveKey("vibevarium-gui-session-lookup");
      const hashId = (id: string) => createHmac("sha256", lookupKey).update(id).digest("base64url");
      const sign = (id: string, key: Buffer) => `${id}.${createHmac("sha256", key).update(id).digest("base64url")}`;
      const unsign = (value: string, key: Buffer): string | undefined => {
        const dot = value.lastIndexOf(".");
        if (dot <= 0) return undefined;
        const id = value.slice(0, dot);
        return safeEqual(sign(id, key), value) ? id : undefined;
      };

      const readRow = (idHash: string) => Effect.promise(() =>
        db.select().from(sessions).where(eq(sessions.idHash, idHash)).limit(1)
      ).pipe(Effect.map((rows) => rows[0]));

      const decryptSession = (row: SessionRow): Session => ({
        sub: row.userSub,
        name: row.userName,
        accessToken: cipher.open(row.accessTokenEncrypted),
        idToken: cipher.open(row.idTokenEncrypted),
        refreshToken: row.refreshTokenEncrypted === null ? undefined : cipher.open(row.refreshTokenEncrypted),
        accessTokenExpiresAt: timestamp(row.accessTokenExpiresAt),
        sessionExpiresAt: timestamp(row.sessionExpiresAt),
      });

      const deleteRow = (idHash: string) => Effect.promise(() =>
        db.delete(sessions).where(eq(sessions.idHash, idHash))
      ).pipe(Effect.asVoid);

      const deleteIfUnchanged = (row: SessionRow) => Effect.promise(() =>
        db.delete(sessions).where(and(
          eq(sessions.idHash, row.idHash),
          eq(sessions.accessTokenEncrypted, row.accessTokenEncrypted),
        ))
      ).pipe(Effect.asVoid);

      const cleanupExpiredSessions = Effect.promise(() => db.execute(sql`
        DELETE FROM sessions WHERE id_hash IN (
          SELECT id_hash FROM sessions
          WHERE session_expires_at <= ${new Date().toISOString()}
          ORDER BY session_expires_at
          LIMIT ${CLEANUP_BATCH_SIZE}
        )
      `)).pipe(Effect.asVoid);

      const cleanupExpiredTransactions = Effect.promise(() => db.execute(sql`
        DELETE FROM session_transactions WHERE id_hash IN (
          SELECT id_hash FROM session_transactions
          WHERE expires_at <= ${new Date().toISOString()}
          ORDER BY expires_at
          LIMIT ${CLEANUP_BATCH_SIZE}
        )
      `)).pipe(Effect.asVoid);

      const refreshLocks = yield* PartitionedSemaphore.make<string>({ permits: 1 });
      const withRefreshLock = <A, E>(idHash: string, work: Effect.Effect<A, E>) =>
        PartitionedSemaphore.withPermit(refreshLocks, idHash)(work);

      const requestRefresh = async (refreshToken: string) => {
        let discovery: { token_endpoint: string };
        try {
          discovery = await fetchDiscovery(options.issuer);
        } catch {
          throw new TransientRefreshFailure("OIDC discovery is temporarily unavailable");
        }

        const body = new URLSearchParams({
          grant_type: "refresh_token",
          client_id: options.clientId,
          refresh_token: refreshToken,
          resource: options.resource,
          scope: options.scope ?? "openid profile email offline_access",
        });
        if (options.clientSecret !== "") body.set("client_secret", options.clientSecret);

        let response: Response;
        try {
          response = await fetch(discovery.token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body,
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          throw new TransientRefreshFailure("OIDC token endpoint is temporarily unavailable");
        }
        const json = await response.json().catch(() => ({})) as {
          access_token?: string;
          id_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error?: string;
        };
        if (!response.ok) {
          if (json.error === "invalid_grant") throw new InvalidRefreshGrant("Refresh grant was rejected");
          throw new TransientRefreshFailure(`OIDC refresh returned HTTP ${response.status}`);
        }
        if (json.access_token === undefined) {
          throw new TransientRefreshFailure("OIDC refresh response had no access token");
        }
        return json as { access_token: string; id_token?: string; refresh_token?: string; expires_in?: number };
      };

      const refreshWithRowLock = (idHash: string): Effect.Effect<Session | undefined, SessionRefreshError> =>
        Effect.tryPromise({
          try: () => db.transaction(async (tx) => {
            // The row lock covers discovery + the provider request + the token
            // update. A second ECS task waits, then reads the committed token
            // generation instead of presenting the old refresh token and
            // deleting the session on invalid_grant before the winner commits.
            const rows = await tx.select().from(sessions).where(eq(sessions.idHash, idHash)).limit(1).for("update");
            const row = rows[0];
            if (row === undefined) return undefined;
            if (timestamp(row.sessionExpiresAt) <= Date.now()) {
              await tx.delete(sessions).where(eq(sessions.idHash, idHash));
              return undefined;
            }
            if (timestamp(row.accessTokenExpiresAt) > Date.now() + refreshSkewMs) return decryptSession(row);
            if (row.refreshTokenEncrypted === null) {
              if (timestamp(row.accessTokenExpiresAt) > Date.now()) return decryptSession(row);
              await tx.delete(sessions).where(eq(sessions.idHash, idHash));
              return undefined;
            }

            let refreshed: Awaited<ReturnType<typeof requestRefresh>>;
            try {
              refreshed = await requestRefresh(cipher.open(row.refreshTokenEncrypted));
            } catch (cause) {
              if (cause instanceof InvalidRefreshGrant) {
                // This task owns the row lock, so no winning refresh can still
                // be in flight elsewhere. The rejection is safe to act on.
                await tx.delete(sessions).where(eq(sessions.idHash, idHash));
                return undefined;
              }
              if (timestamp(row.accessTokenExpiresAt) > Date.now()) return decryptSession(row);
              throw new SessionRefreshError({
                message: "The OIDC provider is temporarily unavailable; retry without starting a new login",
              });
            }

            const updatedRows = await tx.update(sessions).set({
              accessTokenEncrypted: cipher.seal(refreshed.access_token),
              idTokenEncrypted: refreshed.id_token === undefined ? row.idTokenEncrypted : cipher.seal(refreshed.id_token),
              refreshTokenEncrypted: refreshed.refresh_token === undefined
                ? row.refreshTokenEncrypted
                : cipher.seal(refreshed.refresh_token),
              accessTokenExpiresAt: iso(Date.now() + (refreshed.expires_in ?? 3600) * 1000),
              updatedAt: new Date().toISOString(),
            }).where(eq(sessions.idHash, idHash)).returning();
            return updatedRows[0] === undefined ? undefined : decryptSession(updatedRows[0]);
          }),
          catch: (cause) => cause instanceof SessionRefreshError
            ? cause
            : new SessionRefreshError({ message: "The session could not be refreshed; retry the request" }),
        });

      const getSession = (signedId: string): Effect.Effect<Session | undefined, SessionRefreshError> => {
        const id = unsign(signedId, sessionSigningKey);
        if (id === undefined) return Effect.succeed(undefined);
        const idHash = hashId(id);
        return Effect.gen(function*() {
          const row = yield* readRow(idHash);
          if (row === undefined) return undefined;
          if (timestamp(row.sessionExpiresAt) <= Date.now()) {
            yield* deleteRow(idHash);
            return undefined;
          }
          if (timestamp(row.accessTokenExpiresAt) > Date.now() + refreshSkewMs) return decryptSession(row);
          if (row.refreshTokenEncrypted === null) {
            if (timestamp(row.accessTokenExpiresAt) > Date.now()) return decryptSession(row);
            yield* deleteIfUnchanged(row);
            return undefined;
          }
          return yield* withRefreshLock(idHash, refreshWithRowLock(idHash));
        });
      };

      return GuiAuth.of({
        options,
        createSession: (session) => Effect.gen(function*() {
          yield* cleanupExpiredSessions;
          const rawId = base64url(randomBytes(24));
          const now = new Date().toISOString();
          yield* Effect.promise(() => db.insert(sessions).values({
            idHash: hashId(rawId),
            userSub: session.sub,
            userName: session.name,
            accessTokenEncrypted: cipher.seal(session.accessToken),
            idTokenEncrypted: cipher.seal(session.idToken),
            refreshTokenEncrypted: session.refreshToken === undefined ? null : cipher.seal(session.refreshToken),
            accessTokenExpiresAt: iso(session.accessTokenExpiresAt),
            sessionExpiresAt: iso(session.sessionExpiresAt),
            createdAt: now,
            updatedAt: now,
          }));
          return sign(rawId, sessionSigningKey);
        }),
        getSession,
        destroySession: (signedId) => {
          const id = unsign(signedId, sessionSigningKey);
          return id === undefined ? Effect.void : deleteRow(hashId(id));
        },
        rememberPending: ({ verifier, state, returnTo }) => Effect.gen(function*() {
          yield* cleanupExpiredTransactions;
          const rawId = base64url(randomBytes(24));
          const createdAt = Date.now();
          yield* Effect.promise(() => db.insert(sessionTransactions).values({
            idHash: hashId(rawId),
            pkceVerifierEncrypted: cipher.seal(verifier),
            stateHash: hashState(state),
            returnTo: returnTo ?? null,
            expiresAt: iso(createdAt + PENDING_LOGIN_TTL_MS),
            createdAt: iso(createdAt),
          }));
          return sign(rawId, pendingSigningKey);
        }),
        takePending: (signedId) => {
          const id = unsign(signedId, pendingSigningKey);
          if (id === undefined) return Effect.succeed(undefined);
          return Effect.gen(function*() {
            // DELETE ... RETURNING atomically consumes the transaction, so two
            // callbacks cannot exchange the same PKCE verifier or replay state.
            const rows = yield* Effect.promise(() =>
              db.delete(sessionTransactions).where(eq(sessionTransactions.idHash, hashId(id))).returning()
            );
            const row = rows[0];
            if (row === undefined || timestamp(row.expiresAt) <= Date.now()) return undefined;
            return {
              verifier: cipher.open(row.pkceVerifierEncrypted),
              stateHash: row.stateHash,
              ...(row.returnTo === null ? {} : { returnTo: row.returnTo }),
            };
          });
        },
      });
    }));
}

const SESSION_COOKIE = "vibevarium_session";
const PENDING_COOKIE = "vibevarium_login";

/** Cookie attributes; Secure always (prod is HTTPS), Domain only when scoped cross-subdomain. */
const cookieOptions = (cookieDomain: string | undefined) =>
  `Path=/; HttpOnly; SameSite=Lax; Secure${cookieDomain === undefined ? "" : `; Domain=${cookieDomain}`}`;

/** The origin the user is returned to after login/logout (the GUI), defaulting to the API origin. */
const guiOrigin = (options: AuthFlowOptions) => (options.guiOrigin ?? options.baseUrl).replace(/\/+$/, "");

const decodeJwtPayload = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;

const Discovery = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
});

const fetchDiscovery = async (issuer: string) => {
  const response = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC discovery failed: HTTP ${response.status}`);
  return Schema.decodeUnknownSync(Discovery)(await response.json());
};

const internalError = (where: string, cause: unknown) => {
  console.error(`[auth-flow] ${where} failed:`, cause);
  return HttpServerResponse.jsonUnsafe(
    { error: "auth_flow_error", error_description: cause instanceof Error ? cause.message : String(cause) },
    { status: 500 },
  );
};

export const sessionRefreshErrorResponse = () => HttpServerResponse.jsonUnsafe(
  { error: "auth_service_unavailable", error_description: "The identity provider is temporarily unavailable; retry the request" },
  { status: 503, headers: { "retry-after": "5" } },
);

/** GET /auth/login — 302 to the issuer's authorization endpoint with PKCE. */
const loginRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const { options } = guiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Local paths only — never an open redirect.
  const returnToRaw = new URL(request.url, options.baseUrl).searchParams.get("returnTo");
  const returnTo = returnToRaw !== null && returnToRaw.startsWith("/") && !returnToRaw.startsWith("//")
    ? returnToRaw
    : undefined;
  const discovery = yield* Effect.tryPromise({
    try: () => fetchDiscovery(options.issuer),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch((error) => Effect.succeed({ __error: error } as const)));
  if ("__error" in discovery) return internalError("login/discovery", discovery.__error);
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const pendingCookie = yield* guiAuth.rememberPending({
    verifier,
    state,
    ...(returnTo === undefined ? {} : { returnTo }),
  });

  const redirectUri = `${options.baseUrl}/auth/callback`;
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.searchParams.set("client_id", options.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", options.scope ?? "openid profile email offline_access");
  authorize.searchParams.set("resource", options.resource);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "consent");

  return HttpServerResponse.empty({
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": `${PENDING_COOKIE}=${pendingCookie}; ${cookieOptions(options.cookieDomain)}; Max-Age=${PENDING_LOGIN_TTL_MS / 1000}`,
    },
  });
}).pipe(
  Effect.catch((error) => Effect.succeed(internalError("login", error))),
  Effect.catchDefect((defect) => Effect.succeed(internalError("login/defect", defect))),
);

/** GET /auth/callback — exchange the code and set the durable session cookie. */
const callbackRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const { options } = guiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, options.baseUrl);
  const fail = (message: string, status: 400 | 401 = 400) =>
    HttpServerResponse.jsonUnsafe({ error: message }, { status });

  const error = url.searchParams.get("error");
  if (error !== null) {
    return fail(`Sign-in failed: ${error} ${url.searchParams.get("error_description") ?? ""}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) return fail("Missing code or state");

  const pendingCookie = request.cookies[PENDING_COOKIE];
  if (pendingCookie === undefined) return fail("Missing login transaction cookie");
  const pending = yield* guiAuth.takePending(pendingCookie);
  if (pending === undefined) return fail("Unknown or expired login transaction");
  // Only the state's SHA-256 digest was persisted. The transaction has already
  // been consumed, so a mismatch or replay cannot reuse it.
  if (!safeEqual(pending.stateHash, hashState(state))) return fail("State mismatch", 401);

  const discovery = yield* Effect.tryPromise({
    try: () => fetchDiscovery(options.issuer),
    catch: (cause) => cause,
  }).pipe(Effect.mapError(() => new Error("discovery failed")));

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    redirect_uri: `${options.baseUrl}/auth/callback`,
    code,
    code_verifier: pending.verifier,
    resource: options.resource,
  });
  if (options.clientSecret !== "") body.set("client_secret", options.clientSecret);
  const tokenResponse = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await response.json()) as {
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (!response.ok || json.access_token === undefined || json.id_token === undefined) {
        throw new Error(json.error_description ?? json.error ?? `HTTP ${response.status}`);
      }
      return json as { access_token: string; id_token: string; refresh_token?: string; expires_in?: number };
    },
    catch: (cause) => cause,
  }).pipe(Effect.mapError((cause) => new Error(cause instanceof Error ? cause.message : "token exchange failed")));

  const claims = decodeJwtPayload(tokenResponse.id_token);
  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  if (sub === undefined) return fail("ID token has no sub", 401);
  const name =
    (claims.name as string | undefined) ??
    (claims.preferred_username as string | undefined) ??
    (claims.username as string | undefined) ??
    sub;

  const now = Date.now();
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessionCookie = yield* guiAuth.createSession({
    sub,
    name,
    accessToken: tokenResponse.access_token,
    idToken: tokenResponse.id_token,
    refreshToken: tokenResponse.refresh_token,
    accessTokenExpiresAt: now + (tokenResponse.expires_in ?? 3600) * 1000,
    sessionExpiresAt: now + sessionTtlMs,
  });

  return HttpServerResponse.empty({
    status: 302,
    headers: {
      location: pending.returnTo ?? guiOrigin(options),
      "set-cookie": `${SESSION_COOKIE}=${sessionCookie}; ${cookieOptions(options.cookieDomain)}; Max-Age=${Math.ceil(sessionTtlMs / 1000)}`,
    },
  });
});

/** POST /auth/logout — delete the durable row and clear the browser cookie. */
const logoutRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessionId = request.cookies[SESSION_COOKIE];
  if (sessionId !== undefined) yield* guiAuth.destroySession(sessionId);
  const endSession = new URL(
    `${guiAuth.options.issuer.replace(/\/+$/, "")}${guiAuth.options.endSessionPath ?? "/api/logout"}`,
  );
  endSession.searchParams.set("post_logout_redirect_uri", `${guiOrigin(guiAuth.options)}/`);
  return HttpServerResponse.empty({
    status: 302,
    headers: {
      location: endSession.toString(),
      "set-cookie": `${SESSION_COOKIE}=; ${cookieOptions(guiAuth.options.cookieDomain)}; Max-Age=0`,
    },
  });
});

/** GET /auth/me — the actor for the GUI header. */
const meRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessionId = request.cookies[SESSION_COOKIE];
  const resolved = yield* Effect.result(sessionId === undefined ? Effect.succeed(undefined) : guiAuth.getSession(sessionId));
  if (resolved._tag === "Failure") return sessionRefreshErrorResponse();
  const session = resolved.success;
  if (session === undefined) {
    return HttpServerResponse.jsonUnsafe({ actor: null, auth: "on" });
  }
  return yield* HttpServerResponse.json({
    actor: { sub: session.sub, name: session.name },
    auth: "on",
  });
});

export const authFlowRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    yield* router.add("GET", "/auth/login", loginRoute);
    yield* router.add("GET", "/auth/callback", callbackRoute);
    yield* router.add("POST", "/auth/logout", logoutRoute);
    yield* router.add("GET", "/auth/me", meRoute);
  })
);

/** Resolve the GUI actor for ops endpoints. Refresh failures stay typed errors. */
export const sessionFromRequest = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessionId = request.cookies[SESSION_COOKIE];
  return sessionId === undefined ? undefined : yield* guiAuth.getSession(sessionId);
});
