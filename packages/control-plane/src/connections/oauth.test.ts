import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthProviderRow } from "../store/schema.ts";
import { connectionsConfig } from "../config/connections.config.ts";
import { secretRef } from "../config/connections-schema.ts";
import { fetchProviderIdentity } from "./oauth.ts";

const configured = connectionsConfig.oauthProviders.github!;
const { clientSecret, ...definition } = configured;
const provider = {
  ...definition,
  name: "github",
  clientSecretRef: secretRef(connectionsConfig, clientSecret)!,
  defaultScopes: configured.defaultScopes.join(" "),
  responseMode: configured.responseMode ?? "query",
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
      configured.userinfoUrl,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );
  });

  it("falls back to login when GitHub name and email are null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: 43, login: "octocat", name: null, email: null }));

    await expect(fetchProviderIdentity(provider, "token")).resolves.toEqual({ sub: "43", label: "octocat" });
  });
});
