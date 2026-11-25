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
      error_description: "Platform secrets require superadmin",
    }, { status: 403 }));
    const { api, errorMessage } = await import("./api");

    const error = await api.secrets().then(
      () => { throw new Error("Expected the request to fail"); },
      (cause: unknown) => cause,
    );

    expect(errorMessage(error)).toBe("Platform secrets require superadmin");
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
});
