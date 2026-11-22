// API client for the control plane. Every request carries the dev token when set.

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

let token: string | null = globalThis.localStorage?.getItem("terrarium.token") ?? null;

export const getToken = () => token;
export const setToken = (value: string | null) => {
  token = value;
  if (value === null) globalThis.localStorage?.removeItem("terrarium.token");
  else globalThis.localStorage?.setItem("terrarium.token", value);
};

export class ApiError extends Error {
  constructor(readonly status: number, body: unknown) {
    super(typeof body === "object" && body !== null && "error_description" in body
      ? String((body as { error_description: unknown }).error_description)
      : `HTTP ${status}`);
  }
}

export const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, { ...init, headers });
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

const viteEnv = (name: string): string | undefined =>
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];

export const login = async (sub = "user-1", name = "Ada Lovelace") => {
  // The dev issuer mints tokens for the control plane audience; the control
  // plane tells us where it expects tokens from via /whoami's 401 (or we just
  // ask the issuer configured into the page).
  const issuer = viteEnv("VITE_DEV_ISSUER") ?? "http://127.0.0.1:4010";
  const audience = viteEnv("VITE_CONTROL_PLANE_AUDIENCE") ?? "control.terrarium.local";
  const url = new URL("/dev/token", issuer);
  url.searchParams.set("sub", sub);
  url.searchParams.set("name", name);
  url.searchParams.set("aud", audience);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Dev token failed: ${response.status}`);
  const body = await response.json() as { access_token: string };
  setToken(body.access_token);
};

export const logout = () => setToken(null);
