// API client for the control plane. Authentication is a first-party session
// cookie set by the server's /auth/callback — no token is held in JS.

export interface AppRow {
  name: string;
  url: string;
  status: "unknown" | "up" | "down";
  lastSeenAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface DirectoryTool {
  appName: string;
  appUrl: string;
  appStatus: AppRow["status"];
  remoteName: string;
  gatewayName: string;
  descriptor: { description?: string };
  discoveredAt: string;
  stale: boolean;
}

export interface Actor {
  sub: string;
  name?: string;
}

export interface IntegrationView {
  name: string;
  baseUrl: string;
  tokenEnv: string;
  authHeader: string;
  timeoutMs: number;
  tokenConfigured: boolean;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  at: string;
  callerKind: string;
  caller: string;
  app: string;
  integration: string;
  method: string;
  path: string;
  status: string;
  durationMs: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, body: unknown) {
    super(typeof body === "object" && body !== null && "error_description" in body
      ? String((body as { error_description: unknown }).error_description)
      : `HTTP ${status}`);
  }
}

export const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep text bodies (health checks).
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
};

/** Start the real Logto login: full-page redirect to /auth/login, which 302s
 * to the hosted issuer. The callback returns to / with a session cookie. */
export const login = () => {
  globalThis.location.assign("/auth/login");
};

export const logout = async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin", redirect: "manual" });
  globalThis.location.assign("/");
};
