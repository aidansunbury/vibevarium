import type { ProviderManifestEntry } from "./service.ts";

/**
 * Provider manifest (data, not per-provider code — the spike's auth-template
 * idea). ONE real provider for v1: GitHub. The OAuth client credentials come
 * from the SecretsProvider by reference — GITHUB_OAUTH_CLIENT_ID / _SECRET in
 * env locally, SM entries in prod (see CONNECTIONS-SPIKE.md for the GitHub
 * OAuth App settings).
 */
export const GITHUB_PROVIDER: ProviderManifestEntry = {
  name: "github",
  displayName: "GitHub",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userinfoUrl: "https://api.github.com/user",
  apiBaseUrl: "https://api.github.com",
  clientIdRef: "GITHUB_OAUTH_CLIENT_ID",
  clientSecretRef: "GITHUB_OAUTH_CLIENT_SECRET",
  defaultScopes: ["read:user", "user:email"],
  responseMode: "query",
};
