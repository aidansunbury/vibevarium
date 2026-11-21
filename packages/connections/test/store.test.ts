import { afterEach, describe, expect, it } from "vitest"
import { ConnectionsStore } from "../src/store.ts"

let store: ConnectionsStore | undefined

afterEach(async () => {
  await store?.close()
  store = undefined
})

describe("connections store", () => {
  it("optionally encrypts access and refresh tokens at rest", async () => {
    store = await ConnectionsStore.open({ tokenEncryptionKey: "test-only-key" })
    await store.registerProvider({
      name: "datadog",
      displayName: "Datadog",
      authorizeUrl: "https://provider.test/authorize",
      tokenUrl: "https://provider.test/token",
      userinfoUrl: "https://provider.test/userinfo",
      apiBaseUrl: "https://provider.test/api/v1",
      clientId: "client",
      clientSecret: "secret",
      defaultScopes: ["read:metrics"]
    })
    await store.upsertConnection({
      userSub: "user-ada",
      provider: "datadog",
      providerAccountSub: "ada",
      providerAccountLabel: "ada@datadog.test",
      tokens: {
        accessToken: "raw-access-token",
        refreshToken: "raw-refresh-token",
        grantedScopes: "read:metrics",
        expiresAt: Date.now() + 60_000
      }
    })
    const row = await store.connectionForUser("user-ada", "datadog")
    expect(row?.accessToken).toMatch(/^v1:/)
    expect(row?.refreshToken).toMatch(/^v1:/)
    expect(row?.accessToken).not.toContain("raw-access-token")
    expect(row?.refreshToken).not.toContain("raw-refresh-token")
    expect(store.openToken(row?.accessToken ?? "")).toBe("raw-access-token")
    expect(store.openToken(row?.refreshToken ?? "")).toBe("raw-refresh-token")
  })
})
