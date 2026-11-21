import { startFakeOAuthProvider } from "./index.ts"

const provider = await startFakeOAuthProvider({
  name: process.env.PROVIDER_NAME ?? "datadog",
  port: Number(process.env.PORT ?? 4040),
  issuer: process.env.PROVIDER_ISSUER,
  clients: [{
    clientId: process.env.CLIENT_ID ?? "terrarium-control-plane",
    clientSecret: process.env.CLIENT_SECRET ?? "dev-control-plane-secret",
    redirectUris: (process.env.REDIRECT_URIS ?? "http://127.0.0.1:4020/connections/callback")
      .split(",").map((uri) => uri.trim())
  }],
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 3600)
})

console.log(`${provider.name} fake OAuth provider listening at ${provider.issuer}`)
console.log(`Authorize: ${provider.authorizeUrl}`)
console.log(`Discovery: ${provider.issuer}/.well-known/oauth-authorization-server`)
