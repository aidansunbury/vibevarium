/**
 * Real authorization-code + PKCE login for the app against the hosted OIDC
 * provider (Logto). The Worker is a traditional-web (confidential) client:
 * the client secret stays in worker env and the browser only ever holds an
 * opaque, signed, httpOnly session cookie. PKCE (S256) is used as
 * defense-in-depth. Mirrors packages/control-plane/src/auth-flow.ts with one
 * structural change: instead of a server-side session Map, BOTH the pending
 * login transaction and the established session live entirely inside signed
 * cookies (HMAC-SHA256 over the payload, keyed by the client secret).
 *
 * Why stateless signed cookies: a Worker has no guaranteed isolate affinity —
 * an in-memory Map (or a Durable Object) would drop or misroute the login
 * transaction whenever Cloudflare routes /auth/callback to a different
 * isolate than the one that served /auth/login. Signed cookies survive any
 * isolate, need no storage, expire with the token, and are honest about
 * revocation: logout clears the cookie and rotating the secret invalidates
 * every session at once. The session carries an access token minted for a
 * first-party confidential client, so cookie storage is an acceptable risk
 * class for the spike (documented in SPIKE.md).
 *
 * Env (all optional — unset TERRARIUM_CLIENT_SECRET keeps auth off):
 *   TERRARIUM_ISSUER              e.g. https://auth.vibevarium.com/oidc
 *   TERRARIUM_CLIENT_ID           per-app Logto Traditional-web client id
 *   TERRARIUM_CLIENT_SECRET       its secret (worker secret, never in source;
 *                                 the scaffold's auto-registration writes it)
 *   TERRARIUM_PLATFORM_AUDIENCE   RFC 8707 resource the session token targets
 *                                 (https://mcp.<domain> — Option B′)
 *   TERRARIUM_APP_ORIGIN          public origin (defaults to the request's)
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

export interface AuthFlowConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** RFC 8707 resource indicator for the access token (the platform audience). */
  readonly resource: string | undefined;
  /** Public origin of this app; overrides the request-derived origin. */
  readonly appOrigin: string | undefined;
}

/** Read the flow config from the worker env; undefined keeps the flow off. */
export const authFlowConfigFromEnv = (env: Record<string, unknown>): AuthFlowConfig | undefined => {
  const issuer = env.TERRARIUM_ISSUER;
  const clientId = env.TERRARIUM_CLIENT_ID;
  const clientSecret = env.TERRARIUM_CLIENT_SECRET;
  if (
    typeof issuer !== "string" || issuer.length === 0 || typeof clientId !== "string" || clientId.length === 0 ||
    typeof clientSecret !== "string" || clientSecret.length === 0
  ) {
    return undefined;
  }
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    resource: typeof env.TERRARIUM_PLATFORM_AUDIENCE === "string" && env.TERRARIUM_PLATFORM_AUDIENCE.length > 0
      ? env.TERRARIUM_PLATFORM_AUDIENCE
      : undefined,
    appOrigin: typeof env.TERRARIUM_APP_ORIGIN === "string" && env.TERRARIUM_APP_ORIGIN.length > 0
      ? env.TERRARIUM_APP_ORIGIN.replace(/\/+$/, "")
      : undefined,
  };
};

export interface Session {
  readonly sub: string;
  readonly name: string;
  readonly accessToken: string;
  readonly idToken: string;
  readonly expiresAt: number;
}

const SESSION_COOKIE = "terrarium_session";
const PENDING_COOKIE = "terrarium_login";
/** Pending-login transactions are good for 10 minutes. */
const PENDING_TTL_MS = 10 * 60 * 1000;

const cookieOptions = "Path=/; HttpOnly; SameSite=Lax; Secure";

// --- tiny WebCrypto helpers (worker runtime; no node:crypto) ---------------

const bytesToBase64url = (bytes: Uint8Array<ArrayBuffer>): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomBase64url = (length: number): string => {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
};

export const pkcePair = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = randomBase64url(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64url(new Uint8Array(digest)) };
};

const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const part = token.split(".")[1] ?? "";
  const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
};

// --- signed-cookie payloads -------------------------------------------------

export class AuthFlow extends Context.Service<AuthFlow, {
  readonly config: AuthFlowConfig;
  /** base64url(JSON).base64url(hmac) — the open() inverse. */
  readonly seal: (payload: unknown) => Promise<string>;
  /** undefined when the payload is malformed, forged, or undecodable. */
  readonly open: (value: string) => Promise<unknown>;
}>()("app/auth/AuthFlow") {
  static make = (config: AuthFlowConfig): typeof AuthFlow.Service => {
    let keyPromise: Promise<CryptoKey> | undefined;
    const key = () => {
      keyPromise ??= crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(config.clientSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      return keyPromise;
    };
    const seal = async (payload: unknown): Promise<string> => {
      const data = new TextEncoder().encode(JSON.stringify(payload));
      const signature = await crypto.subtle.sign("HMAC", await key(), data);
      return `${bytesToBase64url(data)}.${bytesToBase64url(new Uint8Array(signature))}`;
    };
    const open = async (value: string): Promise<unknown> => {
      const dot = value.lastIndexOf(".");
      if (dot === -1) return undefined;
      let data: Uint8Array<ArrayBuffer>;
      let signature: Uint8Array<ArrayBuffer>;
      try {
        data = base64urlToBytes(value.slice(0, dot));
        signature = base64urlToBytes(value.slice(dot + 1));
      } catch {
        return undefined;
      }
      const valid = await crypto.subtle.verify("HMAC", await key(), signature, data);
      if (!valid) return undefined;
      try {
        return JSON.parse(new TextDecoder().decode(data)) as unknown;
      } catch {
        return undefined;
      }
    };
    return AuthFlow.of({ config, seal, open });
  };
}

const base64urlToBytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const PendingLogin = Schema.Struct({
  verifier: Schema.String,
  state: Schema.String,
  expiresAt: Schema.Number,
});

const SessionPayload = Schema.Struct({
  sub: Schema.String,
  name: Schema.String,
  accessToken: Schema.String,
  idToken: Schema.String,
  expiresAt: Schema.Number,
});

const Discovery = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
});

const fetchDiscovery = async (issuer: string) => {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery failed: HTTP ${response.status}`);
  return Schema.decodeUnknownSync(Discovery)(await response.json());
};

const requestOrigin = (request: HttpServerRequest, flow: AuthFlowConfig): string => {
  if (flow.appOrigin !== undefined) return flow.appOrigin;
  // originalUrl keeps the public absolute URL (the platform rewrites `url` to
  // a relative path as it routes); fall back for runtimes that don't.
  const absolute = request.originalUrl.length > 0 ? request.originalUrl : request.url;
  const url = new URL(absolute, "https://app.terrarium.invalid");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" && forwardedProto.length > 0
    ? forwardedProto.split(",")[0]!.trim()
    : url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
};

const internalError = (where: string, cause: unknown) => {
  console.error(`[auth-flow] ${where} failed:`, cause);
  return HttpServerResponse.jsonUnsafe(
    { error: "auth_flow_error", error_description: cause instanceof Error ? cause.message : String(cause) },
    { status: 500 },
  );
};

const failCallback = (message: string, status: 400 | 401 = 400) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

/** GET /auth/login — 302 to the provider's authorize endpoint with PKCE. */
export const loginRoute = Effect.gen(function*() {
  const flow = yield* AuthFlow;
  const request = yield* HttpServerRequest;
  const discovery = yield* Effect.tryPromise({
    try: () => fetchDiscovery(flow.config.issuer),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch((error) => Effect.succeed({ __error: error } as const)));
  if ("__error" in discovery) return internalError("login/discovery", discovery.__error);

  const pair = yield* Effect.tryPromise({
    try: () => pkcePair(),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch((error) => Effect.succeed({ __error: error } as const)));
  if ("__error" in pair) return internalError("login/pkce", pair.__error);
  const { verifier, challenge } = pair;

  const state = randomBase64url(16);
  const pending = yield* Effect.tryPromise({
    try: () => flow.seal({ verifier, state, expiresAt: Date.now() + PENDING_TTL_MS }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch((error) => Effect.succeed({ __error: error } as const)));
  if (typeof pending !== "string") return internalError("login/seal", pending.__error);

  const origin = requestOrigin(request, flow.config);
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.searchParams.set("client_id", flow.config.clientId);
  authorize.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile offline_access");
  if (flow.config.resource !== undefined) {
    authorize.searchParams.set("resource", flow.config.resource);
  }
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  // First-party apps auto-consent; prompt=consent makes Logto also grant
  // offline_access (a refresh token) alongside the API resource.
  authorize.searchParams.set("prompt", "consent");

  return HttpServerResponse.redirect(authorize.toString(), {
    headers: {
      "set-cookie": `${PENDING_COOKIE}=${pending}; ${cookieOptions}; Max-Age=${Math.floor(PENDING_TTL_MS / 1000)}`,
      "cache-control": "no-store",
    },
  });
}).pipe(
  Effect.catch((error) => Effect.succeed(internalError("login", error))),
  Effect.catchDefect((defect) => Effect.succeed(internalError("login/defect", defect))),
  Effect.orDie,
);

/** GET /auth/callback — exchange the code, verify the transaction, set the session. */
export const callbackRoute = Effect.gen(function*() {
  const flow = yield* AuthFlow;
  const request = yield* HttpServerRequest;
  const url = new URL(request.url, "https://app.terrarium.invalid");
  const fail = failCallback;

  const error = url.searchParams.get("error");
  if (error !== null) {
    return fail(`Sign-in failed: ${error} ${url.searchParams.get("error_description") ?? ""}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) return fail("Missing code or state");

  const pendingCookie = request.cookies[PENDING_COOKIE];
  if (pendingCookie === undefined) return fail("Missing login transaction cookie");
  const pendingRaw = yield* Effect.promise(() => flow.open(pendingCookie));
  const pendingOption = Schema.decodeUnknownOption(PendingLogin)(pendingRaw);
  if (pendingOption._tag === "None") return fail("Unknown or expired login transaction");
  const pending = pendingOption.value;
  if (pending.expiresAt <= Date.now()) return fail("Unknown or expired login transaction");
  if (pending.state !== state) return fail("State mismatch", 401);

  const origin = requestOrigin(request, flow.config);
  const tokenResponse = yield* Effect.tryPromise({
    try: async () => {
      const discovery = await fetchDiscovery(flow.config.issuer);
      // RFC 8707: repeat the resource indicator so the access token is a JWT
      // audience-restricted to the platform resource (Option B′ — the same
      // token shape the meta-MCP + CLI use).
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: flow.config.clientId,
        client_secret: flow.config.clientSecret,
        redirect_uri: `${origin}/auth/callback`,
        code,
        code_verifier: pending.verifier,
      });
      if (flow.config.resource !== undefined) body.set("resource", flow.config.resource);
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
      return json as { access_token: string; id_token: string; expires_in?: number };
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch((cause) => Effect.succeed({ __error: cause } as const)));
  if ("__error" in tokenResponse) return internalError("callback/token-exchange", tokenResponse.__error);

  const claims = decodeJwtPayload(tokenResponse.id_token);
  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  if (sub === undefined) return fail("ID token has no sub", 401);
  const name =
    (claims.name as string | undefined) ??
    (claims.preferred_username as string | undefined) ??
    (claims.username as string | undefined) ??
    sub;

  const expiresAt = Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;
  const session = yield* Effect.tryPromise({
    try: (): Promise<string> =>
      flow.seal({
        sub,
        name,
        accessToken: tokenResponse.access_token,
        idToken: tokenResponse.id_token,
        expiresAt,
      } satisfies Session),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch((cause) => Effect.succeed({ __error: cause } as const)));
  if (typeof session !== "string") return internalError("callback/seal", session.__error);

  return HttpServerResponse.redirect("/", {
    headers: {
      "set-cookie":
        `${SESSION_COOKIE}=${session}; ${cookieOptions}; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`,
      "cache-control": "no-store",
    },
  });
}).pipe(
  Effect.catch((error) => Effect.succeed(internalError("callback", error))),
  Effect.catchDefect((defect) => Effect.succeed(internalError("callback/defect", defect))),
  Effect.orDie,
);

/** GET /auth/logout — clear the session and redirect to the provider end-session. */
export const logoutRoute = Effect.gen(function*() {
  const flow = yield* AuthFlow;
  const request = yield* HttpServerRequest;
  const origin = requestOrigin(request, flow.config);
  const endSession = new URL(`${flow.config.issuer}/session/end`);
  endSession.searchParams.set("post_logout_redirect_uri", `${origin}/`);
  return HttpServerResponse.redirect(endSession.toString(), {
    headers: {
      "set-cookie": `${SESSION_COOKIE}=; ${cookieOptions}; Max-Age=0`,
      "cache-control": "no-store",
    },
  });
}).pipe(Effect.orDie);

/** GET /auth/me — the actor for the SPA header; 401 without a session. */
export const meRoute = Effect.gen(function*() {
  const flow = yield* AuthFlow;
  const request = yield* HttpServerRequest;
  const session = yield* Effect.promise(() => sessionFromCookie(flow, request.cookies[SESSION_COOKIE]));
  if (session === undefined) {
    return HttpServerResponse.jsonUnsafe(
      { actor: null, auth: "on" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  return yield* HttpServerResponse.json({
    actor: { sub: session.sub, name: session.name },
    auth: "on",
  });
}).pipe(Effect.orDie);

/**
 * Open and validate the session cookie value. Returns undefined when the
 * cookie is missing, forged, malformed, or expired.
 */
export const sessionFromCookie = async (
  flow: typeof AuthFlow.Service,
  cookieValue: string | undefined,
): Promise<Session | undefined> => {
  if (cookieValue === undefined) return undefined;
  const payload = await flow.open(cookieValue);
  const session = Schema.decodeUnknownOption(SessionPayload)(payload);
  if (session._tag === "None") return undefined;
  if (session.value.expiresAt <= Date.now()) return undefined;
  return session.value;
};
