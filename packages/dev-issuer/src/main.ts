import { startDevIssuer } from "./index.ts"

const port = Number(process.env.PORT ?? 4010)
const audiences = (process.env.OIDC_AUDIENCES ?? "my-app").split(",").map((audience) => audience.trim())
const issuer = await startDevIssuer({
  port,
  issuer: process.env.OIDC_ISSUER,
  audiences
})

console.log(`Dev OIDC issuer listening at ${issuer.issuer}`)
console.log(`Discovery: ${issuer.issuer}/.well-known/openid-configuration`)
console.log(`Dev token: ${issuer.issuer}/dev/token?sub=user-1&name=Ada&aud=${audiences[0]}`)
