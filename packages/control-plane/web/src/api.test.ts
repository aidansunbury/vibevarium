import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);
vi.stubEnv("VITE_API_ORIGIN", "http://api.test");

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("control-plane API", () => {
  it("surfaces the server's secrets permission error for a 403", async () => {
    fetchMock.mockResolvedValue(Response.json({
      error: "forbidden",
      error_description: "App secrets for tickets require an app admin or superadmin",
    }, { status: 403 }));
    const { api, errorMessage } = await import("./api");

    const error = await api.secrets("tickets").then(
      () => { throw new Error("Expected the request to fail"); },
      (cause: unknown) => cause,
    );

    expect(errorMessage(error)).toBe("App secrets for tickets require an app admin or superadmin");
  });

  it("decodes provider logos", async () => {

    const providers = [{
      name: "github",
      displayName: "GitHub",
      logoUrl: "/provider-logos/github.svg",
      defaultScopes: ["read:user"],
      configured: true,
    }];
    fetchMock.mockResolvedValue(Response.json({ providers }));
    const { api } = await import("./api");

    await expect(api.providers()).resolves.toEqual({ providers });
  });

  it("decodes proxied-secret and webhook logos", async () => {
    const integrations = [{
      name: "openai",
      displayName: "OpenAI",
      logoUrl: "https://example.com/openai.svg",
      secret: "open-ai-api",
      baseUrl: "https://api.openai.com",
      tokenEnv: "OPENAI_API_KEY",
      authHeader: "authorization_bearer",
      timeoutMs: 10_000,
      tokenConfigured: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    const sources = [{
      name: "github",
      displayName: "GitHub",
      logoUrl: "/provider-logos/github.svg",
      secret: "github-webhook-ingress",
      verification: "hmac-sha256",
      eventTypeHeader: "x-github-event",
      enabled: true,
      secretConfigured: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    fetchMock
      .mockResolvedValueOnce(Response.json({ integrations }))
      .mockResolvedValueOnce(Response.json({ sources }));
    const { api } = await import("./api");

    await expect(api.integrations()).resolves.toEqual({ integrations });
    await expect(api.eventSources()).resolves.toEqual({ sources });
  });

  it("surfaces missing webhook delivery mappings", async () => {
    fetchMock.mockResolvedValue(Response.json({
      error: "delivery_credential_not_configured",
      error_description: "App tickets has no webhook delivery credential in connections.config.ts",
    }, { status: 400 }));
    const { api, errorMessage } = await import("./api");

    const error = await api.subscribeEvent({ app: "tickets", source: "github" }).then(
      () => { throw new Error("Expected the request to fail"); },
      (cause: unknown) => cause,
    );
    expect(errorMessage(error)).toContain("no webhook delivery credential");
  });

  it("accepts successful 201 grant and subscription responses", async () => {
    const subscription = {
      id: "sub-1",
      app: "tickets",
      source: "github",
      eventTypes: ["push"],
      scopes: [],
      filter: null,
      status: "active",
      deliveryConfigured: true,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    fetchMock
      .mockResolvedValueOnce(Response.json({ granted: true }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(subscription, { status: 201 }));
    const { api } = await import("./api");

    await api.grantIntegration("openai", "tickets");
    await expect(api.subscribeEvent({ app: "tickets", source: "github" })).resolves.toEqual(subscription);
  });

  it("decodes platform users and superadmin grants", async () => {
    const users = [{
      sub: "user-1",
      name: "Ada",
      email: "ada@example.com",
      isSuperadmin: false,
      superadminSource: null,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    }];
    fetchMock
      .mockResolvedValueOnce(Response.json({ users }))
      .mockResolvedValueOnce(Response.json({ granted: "user-1" }, { status: 201 }));
    const { api } = await import("./api");

    await expect(api.platformUsers()).resolves.toEqual({ users });
    await expect(api.grantSuperadmin("user-1")).resolves.toEqual({ granted: "user-1" });
  });
});
