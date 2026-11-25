import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthProviderRow } from "../store/schema.ts";
import { GITHUB_PROVIDER } from "./manifest.ts";
import { fetchProviderIdentity } from "./oauth.ts";

const provider = {
  ...GITHUB_PROVIDER,
  defaultScopes: GITHUB_PROVIDER.defaultScopes.join(" "),
  responseMode: "query",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies OAuthProviderRow;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchProviderIdentity", () => {
  it("accepts GitHub's id/login user response without an OIDC sub", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: 42, login: "octocat" }));

    await expect(fetchProviderIdentity(provider, "token")).resolves.toEqual({ sub: "42", label: "octocat" });
    expect(fetchMock).toHaveBeenCalledWith(
      GITHUB_PROVIDER.userinfoUrl,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );
  });
});
