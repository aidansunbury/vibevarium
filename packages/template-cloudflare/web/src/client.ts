/**
 * A tiny typed client for the Tickets Api. The Worker serves this SPA and
 * the Api on one origin, so every call is a same-origin fetch. When auth is
 * on, the browser never holds a token: the Worker's auth-code + PKCE flow
 * (/auth/login → /auth/callback) sets an httpOnly session cookie and the API
 * accepts it first-party. Any 401 with a WWW-Authenticate header means the
 * session is missing or expired — the caller bounces to /auth/login, which
 * 302s straight to the hosted sign-in. There is no logged-out UI state.
 */

export interface TicketSummary {
  readonly id: string;
  readonly title: string;
  readonly reporter: string;
  readonly status: "open" | "closed";
}

export interface CommandReceipt {
  readonly reply: unknown;
  readonly stream: string;
  readonly version: number;
}

export interface WhoAmI {
  readonly actor: { readonly sub: string; readonly name?: string } | null;
  readonly auth: "on" | "off";
}

/** The deployed runtime's auth mode, so the UI knows whether login applies. */
export interface AuthStatus {
  readonly enabled: boolean;
  readonly issuer?: string;
}

/** The session's actor, from GET /auth/me (cookie-authenticated). */
export interface Me {
  readonly actor: { readonly sub: string; readonly name?: string } | null;
  readonly auth: "on" | "off";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request was rejected as unauthenticated; the App bounces to /auth/login. */
export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

const parseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const isUnauthenticated = (response: Response) =>
  response.status === 401 || response.headers.get("www-authenticate") !== null;

// Response bodies are trusted to match the worker's Api routes (they are
// generated from the same declaration), so the client casts per route.
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await parseBody(response);
  if (isUnauthenticated(response)) {
    throw new UnauthenticatedError(`${init?.method ?? "GET"} ${path} requires a session`);
  }
  if (!response.ok) {
    throw new ApiError(response.status, body, `${init?.method ?? "GET"} ${path} failed with ${response.status}`);
  }
  return body as T;
};

const encodeStream = (receipt: CommandReceipt) =>
  `?stream=${encodeURIComponent(receipt.stream)}&version=${receipt.version}`;

export const api = {
  /** Read the worker's auth status: is TERRARIUM_ISSUER configured, and at which issuer? */
  authStatus: () => request<AuthStatus>("/auth/status"),

  whoami: () => request<WhoAmI>("/whoami"),

  /** The session actor (httpOnly cookie). 401 → UnauthenticatedError → bounce to login. */
  me: () => request<Me>("/auth/me"),

  // A view that no event has reached yet answers null; the UI treats it as empty.
  listTickets: async () => (await request<{ readonly tickets: readonly TicketSummary[] } | null>("/TicketList/all")) ?? { tickets: [] },

  openTicket: (input: { readonly title: string; readonly reporter: string }) =>
    request<CommandReceipt>("/OpenTicket", {
      method: "POST",
      body: JSON.stringify({ input }),
    }),

  closeTicket: (id: string) =>
    request<CommandReceipt>("/CloseTicket", {
      method: "POST",
      body: JSON.stringify({ target: id, input: {} }),
    }),

  /** Read the list back at a command's version so the UI shows its own write. */
  listTicketsAtLeast: async (receipt: CommandReceipt) =>
    (await request<{ readonly tickets: readonly TicketSummary[] } | null>(`/TicketList/all${encodeStream(receipt)}`)) ??
      { tickets: [] },
};

/** Hard navigation to the login flow; the Worker 302s to the hosted sign-in. */
export const redirectToLogin = () => {
  window.location.assign("/auth/login");
};

/** Hard navigation to logout; the Worker clears the cookie and ends the provider session. */
export const redirectToLogout = () => {
  window.location.assign("/auth/logout");
};
