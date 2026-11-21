import { describe, expect, it } from "vitest"
import { runConnectionsDemo } from "../src/demo.ts"

describe("connections meta-OAuth spike", () => {
  it("connects once, consents once, vends and proxies, refreshes, and revokes", async () => {
    const report = await runConnectionsDemo()

    expect(report.connect.start.status).toBe(200)
    expect(report.connect.providerConsent.html).toContain("terrarium-control-plane")
    expect(report.connect.providerConsent.html).toContain("read:metrics")
    expect(report.connect.providerApproved.html).toContain('method="post"')
    expect(report.connect.callback).toMatchObject({
      status: 200,
      body: {
        user_sub: "user-ada",
        provider: "datadog",
        provider_account: { sub: "ada", label: "ada@datadog.test" },
        granted_scopes: ["read:metrics"],
        status: "active"
      }
    })

    expect(report.grant.consentWithoutUserToken.status).toBe(401)
    expect(report.grant.consent.html).toContain("App metrics-dashboard wants your Datadog (read:metrics)")
    expect(report.grant.approval.body).toMatchObject({
      status: "approved",
      grant: { app_id: "metrics-dashboard", owner_sub: "user-ada", status: "approved" }
    })

    expect(report.use.vend.status).toBe(200)
    expect(report.use.vend.body.access_token).toContain("redacted")
    expect(report.use.directProviderCall).toMatchObject({ status: 200, body: { status: "ok" } })
    expect(report.use.proxyCall).toMatchObject({
      status: 200,
      tokenRefreshed: "true",
      body: { status: "ok" }
    })
    expect(report.providerState.refreshTokenRotations).toBeGreaterThanOrEqual(1)
    expect(report.providerState.apiRequests).toBe(2)

    expect(report.revokeGrant.revocation.body).toMatchObject({ status: "revoked" })
    expect(report.revokeGrant.vend.status).toBe(403)
    expect(report.revokeGrant.proxy.status).toBe(403)
    expect(report.revokeConnection.revocation.body).toMatchObject({ status: "revoked" })
    expect(report.revokeConnection.vend.status).toBe(403)
    expect(report.revokeConnection.proxy.status).toBe(403)
  }, 30_000)
})
