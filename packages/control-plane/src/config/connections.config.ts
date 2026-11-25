import type { ConnectionsConfig } from "./connections-schema.ts";

/**
 * Connection catalog: OAuth providers, shared proxied credentials, and webhooks.
 *
 * This file contains metadata and stable slugs ONLY — never secret values.
 * Put each value in AWS Secrets Manager (or an env var for local development),
 * then point its `ref` at that value below. Removing an OAuth provider, proxied
 * secret, or webhook from this file disables it without deleting runtime grants.
 */
export const connectionsConfig = {
  secrets: {
    "github-oauth-client": { ref: "GITHUB_OAUTH_CLIENT_SECRET" },
    "linear-oauth-client": { ref: "LINEAR_OAUTH_CLIENT_SECRET" },
    "oauth-token-encryption": { ref: "CONNECTIONS_TOKEN_ENCRYPTION_KEY" },
    "github-webhook-ingress": { ref: "GITHUB_WEBHOOK_SECRET" },

    // Example shared API credential, referenced by `proxiedSecrets` below:
    // "open-ai-api": { ref: "OPENAI_API_KEY" },
    // Example app-to-webhook delivery credential:
    // "my-app-webhook-delivery": { ref: "APP_EVENTS_SECRET_MY_APP" },
  },

  oauthTokenEncryption: "oauth-token-encryption",

  oauthProviders: {
    github: {
      displayName: "GitHub",
      logoUrl: "/provider-logos/github.svg",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userinfoUrl: "https://api.github.com/user",
      apiBaseUrl: "https://api.github.com",
      clientIdRef: "GITHUB_OAUTH_CLIENT_ID",
      clientSecret: "github-oauth-client",
      defaultScopes: ["read:user", "user:email"],
      responseMode: "query",
    },
    linear: {
      displayName: "Linear",
      logoUrl: "/provider-logos/linear.svg",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      userinfoUrl: "https://api.linear.app/graphql",
      apiBaseUrl: "https://api.linear.app",
      clientIdRef: "LINEAR_OAUTH_CLIENT_ID",
      clientSecret: "linear-oauth-client",
      defaultScopes: ["read", "write"],
      responseMode: "query",
      scopeSeparator: ",",
      authorizeParams: { actor: "user" },
      identity: "linear",
    },
  },

  proxiedSecrets: {
    // Example: apps granted "openai" use the same OpenAI token through the proxy.
    // openai: {
    //   displayName: "OpenAI",
    //   logoUrl: "/provider-logos/openai.svg",
    //   baseUrl: "https://api.openai.com",
    //   secret: "open-ai-api",
    //   authHeader: "authorization_bearer",
    //   timeoutMs: 10_000,
    // },
  },

  webhooks: {
    github: {
      displayName: "GitHub",
      logoUrl: "/provider-logos/github.svg",
      secret: "github-webhook-ingress",
      verification: "hmac-sha256",
      eventTypeHeader: "x-github-event",
    },
  },

  // Each subscribed app needs a delivery credential. The same value must also
  // be installed as TERRARIUM_EVENTS_SECRET in that app's Worker.
  webhookDeliverySecrets: {
    // "my-app": "my-app-webhook-delivery",
  },
} satisfies ConnectionsConfig;
