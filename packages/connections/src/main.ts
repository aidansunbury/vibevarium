import { startDevIssuer } from "@vibevarium/dev-issuer"
import { startFakeOAuthProvider } from "@vibevarium/fake-oauth"
import { startConnectionsServer } from "./server.ts"

const host = "127.0.0.1"
const devPort = Number(process.env.OIDC_PORT ?? 4010)
const connectionsPort = Number(process.env.PORT ?? 4020)
const providerPort = Number(process.env.PROVIDER_PORT ?? 4040)
const audience = "vibevarium-control-plane"
const issuer = process.env.OIDC_ISSUER ?? `http://${host}:${devPort}`

const devIssuer = await startDevIssuer({ port: devPort, host, issuer, audiences: [audience] })
const connections = await startConnectionsServer({
  port: connectionsPort,
  host,
  oidc: { issuer: devIssuer.issuer, audience },
  apps: [{ id: "metrics-dashboard", secret: process.env.APP_SECRET ?? "metrics-dashboard-dev-secret" }],
  database: process.env.PGLITE_DATA_DIR
    ? { dataDir: process.env.PGLITE_DATA_DIR, tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY }
    : { tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY }
})
const provider = await startFakeOAuthProvider({
  name: process.env.PROVIDER_NAME ?? "datadog",
  port: providerPort,
  host,
  clients: [{
    clientId: "vibevarium-control-plane",
    clientSecret: process.env.PROVIDER_CLIENT_SECRET ?? "dev-control-plane-secret",
    redirectUris: [`${connections.baseUrl}/connections/callback`]
  }]
})
await connections.registerProvider({
  name: provider.name,
  displayName: "Datadog",
  authorizeUrl: provider.authorizeUrl,
  tokenUrl: provider.tokenUrl,
  userinfoUrl: provider.userinfoUrl,
  apiBaseUrl: provider.apiBaseUrl,
  clientId: "vibevarium-control-plane",
  clientSecret: process.env.PROVIDER_CLIENT_SECRET ?? "dev-control-plane-secret",
  defaultScopes: ["read:metrics"],
  responseMode: "form_post"
})

console.log(`Dev OIDC issuer: ${devIssuer.issuer}`)
console.log(`Fake ${provider.name}: ${provider.issuer}`)
console.log(`Connections: ${connections.baseUrl}`)
console.log(`Ada token: ${devIssuer.issuer}/dev/token?sub=user-ada&name=Ada&aud=${audience}`)

const shutdown = async () => {
  await Promise.allSettled([connections.close(), provider.close(), devIssuer.close()])
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
