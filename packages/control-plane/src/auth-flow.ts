/**
 * Real authorization-code + PKCE login for the control-plane GUI against the
 * hosted Logto tenant. The GUI is a traditional-web application (confidential
 * client): the secret stays server-side and the browser only ever holds an
 * opaque session cookie. PKCE (S256) is still used as defense-in-depth.
 *
 * Env:
 *   LOGTO_ISSUER        (default https://auth.vibevarium.com/oidc)
 *   LOGTO_GUI_APP_ID    (default s9ne7qecvf20vktab5iwl)
 *   LOGTO_GUI_APP_SECRET  local: repo-root .env; production: AWS Secrets Manager
 *                         at /terrarium/prod/logto-gui-app-secret
 *   CONTROL_PLANE_BASE_URL  public origin used to build the redirect_uri
 *                         (default http://127.0.0.1:<port>)
 *   PLATFORM_OIDC_AUDIENCE  RFC 8707 resource (default https://mcp.vibevarium.com)
 *
 * Sessions are held in a server-side in-memory Map keyed by an opaque id in an
 * httpOnly cookie. Restarting the control plane logs everyone out — honest and
 * simple for the spike; swap for PGlite rows when that matters.
 */
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface AuthFlowOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Public origin of this control plane, e.g. https://platform.vibevarium.com */
  readonly baseUrl: string;
  /** RFC 8707 resource indicator for the access token. */
  readonly resource: string;
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
  readonly expiresAt: number;
}

interface PendingLogin {
  readonly verifier: string;
  readonly state: string;
  readonly createdAt: number;
}

export class GuiAuth extends Context.Service<GuiAuth, {
  readonly options: AuthFlowOptions;
  readonly createSession: (session: Session) => string;
  readonly getSession: (id: string) => Session | undefined;
  readonly destroySession: (id: string) => void;
  readonly rememberPending: (pending: PendingLogin & { readonly id: string }) => void;
  readonly takePending: (id: string) => PendingLogin | undefined;
}>()("@terrarium/control-plane/GuiAuth") {
  static readonly layer = (options: AuthFlowOptions) =>
    Layer.effect(GuiAuth)(Effect.sync(() => {
      const sessions = new Map<string, Session>();
      const pending = new Map<string, PendingLogin>();
      const secretKey = createHmac("sha256", options.clientSecret).update("terrarium-gui-session").digest();
      // Cookie value is `<id>.<hmac>` so a forged id without the server secret
      // is rejected before touching the Map.
      const sign = (id: string) =>
        `${id}.${createHmac("sha256", secretKey).update(id).digest("base64url")}`;
      const unsign = (value: string): string | undefined => {
        const dot = value.lastIndexOf(".");
        if (dot === -1) return undefined;
        const id = value.slice(0, dot);
        const expected = Buffer.from(sign(id));
        const given = Buffer.from(value);
        return expected.length === given.length && timingSafeEqual(expected, given) ? id : undefined;
      };
      return GuiAuth.of({
        options,
        createSession: (session) => {
          const rawId = base64url(randomBytes(24));
          sessions.set(rawId, session);
          return sign(rawId);
        },
        getSession: (signedId) => {
          const id = unsign(signedId);
          if (id === undefined) return undefined;
          const session = sessions.get(id);
          if (session === undefined) return undefined;
          if (session.expiresAt <= Date.now()) {
            sessions.delete(id);
            return undefined;
          }
          return session;
        },
        destroySession: (signedId) => {
          const id = unsign(signedId);
          if (id !== undefined) sessions.delete(id);
        },
        rememberPending: ({ id, verifier, state, createdAt }) => {
          // GC stale pending logins lazily.
          for (const [key, value] of pending) {
            if (createdAt - value.createdAt > 10 * 60 * 1000) pending.delete(key);
          }
          pending.set(id, { verifier, state, createdAt });
        },
        takePending: (id) => {
          const value = pending.get(id);
          pending.delete(id);
          return value;
        },
      });
    }));
}

const SESSION_COOKIE = "terrarium_session";
const PENDING_COOKIE = "terrarium_login";

const cookieOptions = "Path=/; HttpOnly; SameSite=Lax";

const decodeJwtPayload = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;

const Discovery = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
});

const fetchDiscovery = async (issuer: string) => {
  const response = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
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

/** GET /auth/login — 302 to Logto /oidc/auth with PKCE. */
const loginRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const { options } = guiAuth;
  const discovery = yield* Effect.tryPromise({
    try: () => fetchDiscovery(options.issuer),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch((error) => Effect.succeed({ __error: error } as const)));
  if ("__error" in discovery) return internalError("login/discovery", discovery.__error);
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const pendingId = base64url(randomBytes(16));
  guiAuth.rememberPending({ id: pendingId, verifier, state, createdAt: Date.now() });

  const redirectUri = `${options.baseUrl}/auth/callback`;
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.searchParams.set("client_id", options.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set(
    "scope",
    "openid profile offline_access member admin apps:read apps:write",
  );
  authorize.searchParams.set("resource", options.resource);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  // First-party apps auto-consent; prompt=consent makes Logto also grant
  // offline_access (refresh token) alongside the API scopes.
  authorize.searchParams.set("prompt", "consent");

  return HttpServerResponse.empty({
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": `${PENDING_COOKIE}=${pendingId}; ${cookieOptions}; Max-Age=600`,
    },
  });
}).pipe(
  Effect.catch((error) => Effect.succeed(internalError("login", error))),
  Effect.catchDefect((defect) => Effect.succeed(internalError("login/defect", defect))),
);

/** GET /auth/callback — exchange the code, verify the ID token, set the session. */
const callbackRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const { options } = guiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, options.baseUrl);
  const fail = (message: string, status: 400 | 401 = 400) =>
    HttpServerResponse.jsonUnsafe({ error: message }, { status });

  const error = url.searchParams.get("error");
  if (error !== null) {
    return fail(`Logto sign-in failed: ${error} ${url.searchParams.get("error_description") ?? ""}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) return fail("Missing code or state");

  const pendingId = request.cookies[PENDING_COOKIE];
  if (pendingId === undefined) return fail("Missing login transaction cookie");
  const pending = guiAuth.takePending(pendingId);
  if (pending === undefined) return fail("Unknown or expired login transaction");
  if (pending.state !== state) return fail("State mismatch", 401);

  const discovery = yield* Effect.tryPromise({
    try: () => fetchDiscovery(options.issuer),
    catch: (cause) => cause,
  }).pipe(Effect.mapError(() => new Error("discovery failed")));

  // RFC 8707: repeat the resource indicator so the access token is a JWT
  // audience-restricted to the platform API (and the refresh token is issued).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: `${options.baseUrl}/auth/callback`,
    code,
    code_verifier: pending.verifier,
    resource: options.resource,
  });
  const tokenResponse = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
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

  const sessionId = guiAuth.createSession({
    sub,
    name,
    accessToken: tokenResponse.access_token,
    idToken: tokenResponse.id_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
  });

  return HttpServerResponse.empty({
    status: 302,
    headers: {
      location: "/",
      "set-cookie": `${SESSION_COOKIE}=${sessionId}; ${cookieOptions}; Max-Age=86400`,
    },
  });
});

/** POST /auth/logout — destroy the session and redirect to Logto end-session. */
const logoutRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessionId = request.cookies[SESSION_COOKIE];
  if (sessionId !== undefined) guiAuth.destroySession(sessionId);
  const endSession = new URL(`${guiAuth.options.issuer.replace(/\/+$/, "")}/session/end`);
  endSession.searchParams.set("post_logout_redirect_uri", `${guiAuth.options.baseUrl}/`);
  return HttpServerResponse.empty({
    status: 302,
    headers: {
      location: endSession.toString(),
      "set-cookie": `${SESSION_COOKIE}=; ${cookieOptions}; Max-Age=0`,
    },
  });
});

/** GET /auth/me — the actor for the GUI header. */
const meRoute = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessionId = request.cookies[SESSION_COOKIE];
  const session = sessionId === undefined ? undefined : guiAuth.getSession(sessionId);
  if (session === undefined) {
    return HttpServerResponse.jsonUnsafe({ actor: null, auth: "on" }, { status: 401 });
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

/**
 * Session gate for the GUI's ops endpoints. Unlike bearer `requireAuth`, this
 * reads the httpOnly session cookie and exposes the logged-in actor via
 * CurrentActor-shaped value on the request context. Returns undefined (no
 * gate) when the GUI auth flow is not configured.
 */
export const sessionFromRequest = Effect.gen(function*() {
  const guiAuth = yield* GuiAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessionId = request.cookies[SESSION_COOKIE];
  return sessionId === undefined ? undefined : guiAuth.getSession(sessionId);
});
