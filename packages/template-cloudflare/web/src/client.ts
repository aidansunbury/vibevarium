/**
 * A tiny typed client for the Tickets Api. The Worker serves this SPA and
 * the Api on one origin, so every call is a same-origin fetch. When the
 * auth seam is on, a bearer token (held in memory + sessionStorage) is
 * attached to every request.
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

/** The deployed runtime's auth mode, so the UI knows whether to offer login. */
export interface AuthStatus {
  readonly enabled: boolean;
  readonly issuer?: string;
}

let bearerToken: string | null = sessionStorage.getItem("tickets.token");

export const getToken = () => bearerToken;

export const setToken = (token: string | null) => {
  bearerToken = token;
  if (token === null) {
    sessionStorage.removeItem("tickets.token");
  } else {
    sessionStorage.setItem("tickets.token", token);
  }
};

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

const parseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// Response bodies are trusted to match the worker's Api routes (they are
// generated from the same declaration), so the client casts per route.
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (bearerToken !== null) {
    headers.set("authorization", `Bearer ${bearerToken}`);
  }
  const response = await fetch(path, { ...init, headers });
  const body = await parseBody(response);
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

  /**
   * Dev-only login: the dev-issuer mints a token directly (no redirect).
   * When the real hosted OIDC provider is live, this becomes a redirect to
   * its hosted login page with an authorization-code + PKCE return — the
   * token handling below (memory + bearer on API calls) stays identical.
   */
  devLogin: async (
    issuer: string,
    input: { readonly sub: string; readonly name: string; readonly audience: string },
  ) => {
    const url = new URL("/dev/token", issuer);
    url.searchParams.set("sub", input.sub);
    url.searchParams.set("name", input.name);
    url.searchParams.set("aud", input.audience);
    const response = await fetch(url);
    if (!response.ok) {
      throw new ApiError(response.status, null, `dev-issuer token request failed with ${response.status}`);
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("access_token" in body)) {
      throw new ApiError(response.status, body, "dev-issuer returned an invalid token response");
    }
    const token = (body as Record<"access_token", unknown>).access_token;
    if (typeof token !== "string") {
      throw new ApiError(response.status, body, "dev-issuer returned an invalid token response");
    }
    setToken(token);
    return token;
  },
};
