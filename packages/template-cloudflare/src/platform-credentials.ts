/**
 * Server-side credentials for platform integration calls. Pass the signed-in
 * user's platform access token when proxying or vending an OAuth connection.
 */
export const platformCredentialHeaders = async (
  env: Record<string, unknown>,
  userAccessToken?: string,
): Promise<Headers> => {
  const { TERRARIUM_ISSUER: issuer, TERRARIUM_PLATFORM_AUDIENCE: audience,
    TERRARIUM_M2M_CLIENT_ID: clientId, TERRARIUM_M2M_CLIENT_SECRET: clientSecret } = env;
  if (typeof issuer !== "string" || typeof audience !== "string" ||
      typeof clientId !== "string" || typeof clientSecret !== "string" ||
      !issuer || !audience || !clientId || !clientSecret) {
    throw new Error("Platform app credentials are not configured");
  }

  const issuerUrl = issuer.replace(/\/+$/, "");
  const discovery = await fetch(`${issuerUrl}/.well-known/openid-configuration`);
  if (!discovery.ok) throw new Error(`OIDC discovery failed (HTTP ${discovery.status})`);
  const metadata = await discovery.json() as { issuer?: string; token_endpoint?: string };
  if (metadata.issuer !== issuerUrl || typeof metadata.token_endpoint !== "string" ||
      new URL(metadata.token_endpoint).origin !== new URL(issuerUrl).origin) {
    throw new Error("Invalid OIDC token endpoint");
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      resource: `${audience.replace(/\/$/, "")}/app`,
    }),
  });
  if (!response.ok) throw new Error(`App token request failed (HTTP ${response.status})`);
  const { access_token: accessToken } = await response.json() as { access_token?: string };
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("OIDC token endpoint returned no app access token");
  }
  const headers = new Headers({ authorization: `Bearer ${accessToken}` });
  if (userAccessToken !== undefined) headers.set("x-vibevarium-user-authorization", `Bearer ${userAccessToken}`);
  return headers;
};
