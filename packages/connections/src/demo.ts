import * as Effect from "effect/Effect"
import { DevAuth } from "@vibevarium/auth"
import { startDevIssuer } from "@vibevarium/dev-issuer"
import { startFakeOAuthProvider } from "@vibevarium/fake-oauth"
import { startConnectionsServer } from "./server.ts"

const APP_ID = "metrics-dashboard"
const APP_SECRET = "metrics-dashboard-dev-secret"
const AUDIENCE = "vibevarium-control-plane"

const appHeaders = {
  authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`,
  "content-type": "application/json"
}

const decodeHtml = (value: string) => value
  .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">").replaceAll("&amp;", "&")

const formFromHtml = (html: string) => {
  const action = decodeHtml(html.match(/<form[^>]+action="([^"]+)"/)?.[1] ?? "")
  const fields = new URLSearchParams()
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    if (match[1] && match[2] !== undefined) fields.set(decodeHtml(match[1]), decodeHtml(match[2]))
  }
  if (!action) throw new Error("Demo could not find the provider form action")
  return { action, fields }
}

const redactCallbackHtml = (html: string) => html
  .replace(/(name="code" value=")[^"]*(")/, "$1<redacted>$2")
  .replace(/(name="state" value=")[^"]*(")/, "$1<redacted>$2")

const redactAuthorizeHtml = (html: string) => html
  .replace(/(name="state" value=")[^"]*(")/, "$1<redacted>$2")
  .replace(/(name="code_challenge" value=")[^"]*(")/, "$1<redacted>$2")

const redactedStart = (start: { readonly authorization_url: string; readonly state: string }) => {
  const url = new URL(start.authorization_url)
  url.searchParams.set("state", "<redacted>")
  url.searchParams.set("code_challenge", "<redacted>")
  return { ...start, authorization_url: url.toString(), state: "<redacted>" }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const runConnectionsDemo = async () => {
  const devIssuer = await startDevIssuer({ port: 0, audiences: [AUDIENCE] })
  const connections = await startConnectionsServer({
    port: 0,
    oidc: { issuer: devIssuer.issuer, audience: AUDIENCE },
    apps: [{ id: APP_ID, secret: APP_SECRET, displayName: "Metrics Dashboard" }],
    database: { tokenEncryptionKey: "local-spike-encryption-key" },
    refreshSkewMs: 4_000
  })
  const provider = await startFakeOAuthProvider({
    name: "datadog",
    port: 0,
    accessTokenTtlSeconds: 5,
    clients: [{
      clientId: "vibevarium-control-plane",
      clientSecret: "dev-control-plane-secret",
      redirectUris: [`${connections.baseUrl}/connections/callback`]
    }]
  })
  try {
    await connections.registerProvider({
      name: "datadog",
      displayName: "Datadog",
      authorizeUrl: provider.authorizeUrl,
      tokenUrl: provider.tokenUrl,
      userinfoUrl: provider.userinfoUrl,
      apiBaseUrl: provider.apiBaseUrl,
      clientId: "vibevarium-control-plane",
      clientSecret: "dev-control-plane-secret",
      defaultScopes: ["read:metrics"],
      responseMode: "form_post"
    })
    const ada = await Effect.runPromise(DevAuth.fetchToken({
      issuer: devIssuer.issuer,
      sub: "user-ada",
      name: "Ada",
      audience: AUDIENCE
    }))
    const userHeaders = { authorization: `Bearer ${ada.access_token}` }

    const startResponse = await fetch(`${connections.baseUrl}/connections/start`, {
      method: "POST",
      headers: { ...userHeaders, "content-type": "application/json" },
      body: JSON.stringify({ provider: "datadog" })
    })
    const start = await startResponse.json() as {
      authorization_url: string
      state: string
      provider: string
      expires_at: string
    }

    const providerConsentResponse = await fetch(start.authorization_url)
    const providerConsentHtml = await providerConsentResponse.text()
    const authorizeForm = formFromHtml(providerConsentHtml)
    authorizeForm.fields.set("provider_user", "ada")
    const providerApprovedResponse = await fetch(authorizeForm.action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authorizeForm.fields
    })
    const providerApprovedHtml = await providerApprovedResponse.text()
    const callbackForm = formFromHtml(providerApprovedHtml)
    if (callbackForm.fields.get("state") !== start.state) throw new Error("OAuth state did not round-trip")

    const callbackResponse = await fetch(callbackForm.action, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: callbackForm.fields
    })
    const connection = await callbackResponse.json() as { connection_id: string }

    const requestGrant = async () => {
      const response = await fetch(`${connections.baseUrl}/grants/request`, {
        method: "POST",
        headers: appHeaders,
        body: JSON.stringify({ appId: APP_ID, provider: "datadog", scopes: ["read:metrics"] })
      })
      return { response, body: await response.json() as { consent_url: string } }
    }
    const approveGrant = async (grantId: string) => {
      const response = await fetch(`${connections.baseUrl}/grants/decision`, {
        method: "POST",
        headers: {
          ...userHeaders,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json"
        },
        body: new URLSearchParams({ grant: grantId, decision: "approve" })
      })
      return { response, body: await response.json() as { grant: { grant_id: string } } }
    }

    const grantRequest = await requestGrant()
    const grantId = new URL(grantRequest.body.consent_url).searchParams.get("grant") ?? ""
    const unauthenticatedConsent = await fetch(grantRequest.body.consent_url)
    const consentResponse = await fetch(grantRequest.body.consent_url, { headers: userHeaders })
    const consentHtml = await consentResponse.text()
    const approval = await approveGrant(grantId)

    const vendToken = async () => {
      const response = await fetch(`${connections.baseUrl}/vend`, {
        method: "POST",
        headers: appHeaders,
        body: JSON.stringify({ appId: APP_ID, provider: "datadog" })
      })
      return { response, body: await response.json() as { access_token?: string } }
    }
    const proxyMetrics = async () => fetch(`${connections.baseUrl}/proxy/datadog/metrics?site=dev`, {
      headers: { authorization: appHeaders.authorization }
    })

    const vend = await vendToken()
    if (!vend.body.access_token) throw new Error("Demo did not vend an access token")
    const directResponse = await fetch(`${provider.apiBaseUrl}/metrics`, {
      headers: { authorization: `Bearer ${vend.body.access_token}` }
    })
    const directBody = await directResponse.json()

    await sleep(1_100)
    const proxyResponse = await proxyMetrics()
    const proxyBody = await proxyResponse.json()

    const revokeResponse = await fetch(`${connections.baseUrl}/grants/revoke`, {
      method: "POST",
      headers: { ...userHeaders, "content-type": "application/json" },
      body: JSON.stringify({ grantId: approval.body.grant.grant_id })
    })
    const revokedGrant = await revokeResponse.json()
    const vendAfterRevoke = await vendToken()
    const proxyAfterRevoke = await proxyMetrics()
    const proxyAfterRevokeBody = await proxyAfterRevoke.json()

    const secondGrant = await requestGrant()
    const secondGrantId = new URL(secondGrant.body.consent_url).searchParams.get("grant") ?? ""
    const secondApproval = await approveGrant(secondGrantId)
    const connectionRevokeResponse = await fetch(`${connections.baseUrl}/connections/revoke`, {
      method: "POST",
      headers: { ...userHeaders, "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connection.connection_id })
    })
    const revokedConnection = await connectionRevokeResponse.json()
    const vendAfterConnectionRevoke = await vendToken()
    const proxyAfterConnectionRevoke = await proxyMetrics()
    const proxyAfterConnectionRevokeBody = await proxyAfterConnectionRevoke.json()

    const { access_token: _accessToken, ...vendWithoutToken } = vend.body
    return {
      actors: { user: { sub: "user-ada", name: "Ada" }, app: APP_ID, provider: provider.name },
      connect: {
        start: { status: startResponse.status, body: redactedStart(start) },
        providerConsent: { status: providerConsentResponse.status, html: redactAuthorizeHtml(providerConsentHtml) },
        providerApproved: { status: providerApprovedResponse.status, html: redactCallbackHtml(providerApprovedHtml) },
        callback: { status: callbackResponse.status, body: connection }
      },
      grant: {
        request: { status: grantRequest.response.status, body: grantRequest.body },
        consentWithoutUserToken: { status: unauthenticatedConsent.status, body: await unauthenticatedConsent.json() },
        consent: { status: consentResponse.status, html: consentHtml },
        approval: { status: approval.response.status, body: approval.body }
      },
      use: {
        vend: {
          status: vend.response.status,
          body: { ...vendWithoutToken, access_token: "<redacted RS256 JWT; used for the direct call below>" }
        },
        directProviderCall: { status: directResponse.status, body: directBody },
        proxyCall: {
          status: proxyResponse.status,
          tokenRefreshed: proxyResponse.headers.get("x-vibevarium-token-refreshed"),
          grantId: proxyResponse.headers.get("x-vibevarium-grant-id"),
          body: proxyBody
        }
      },
      revokeGrant: {
        revocation: { status: revokeResponse.status, body: revokedGrant },
        vend: { status: vendAfterRevoke.response.status, body: vendAfterRevoke.body },
        proxy: { status: proxyAfterRevoke.status, body: proxyAfterRevokeBody }
      },
      revokeConnection: {
        secondApproval: { status: secondApproval.response.status, body: secondApproval.body },
        revocation: { status: connectionRevokeResponse.status, body: revokedConnection },
        vend: { status: vendAfterConnectionRevoke.response.status, body: vendAfterConnectionRevoke.body },
        proxy: { status: proxyAfterConnectionRevoke.status, body: proxyAfterConnectionRevokeBody }
      },
      providerState: provider.snapshot()
    }
  } finally {
    await Promise.allSettled([connections.close(), provider.close(), devIssuer.close()])
  }
}
