const domain = process.env.TERRARIUM_DOMAIN;
if (!domain) throw new Error("Set TERRARIUM_DOMAIN");

const expectedSha = process.argv[2] ?? process.env.EXPECTED_GIT_SHA;

const json = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
};

const text = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
};

if (await text(`https://api.${domain}/health`) !== "ok") {
  throw new Error("API health check did not return ok");
}

const config = await json(`https://api.${domain}/config-check`);
if (expectedSha && config.deployedGitSha !== expectedSha) {
  throw new Error(`Expected deployed SHA ${expectedSha}, got ${config.deployedGitSha ?? "unset"}`);
}
for (const name of [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "LINEAR_OAUTH_CLIENT_ID",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "CONNECTIONS_TOKEN_ENCRYPTION_KEY",
]) {
  if (config.config?.[name]?.set !== true) throw new Error(`Required secret is unset: ${name}`);
}

const oidc = await json(`https://auth.${domain}/orgs/vibevarium/.well-known/openid-configuration`);
if (oidc.issuer !== `https://auth.${domain}/orgs/vibevarium`) {
  throw new Error(`Unexpected OIDC issuer: ${oidc.issuer}`);
}

const resource = await json(`https://api.${domain}/.well-known/oauth-protected-resource`);
if (resource.resource !== `https://api.${domain}/mcp`) {
  throw new Error(`Unexpected MCP resource: ${resource.resource}`);
}

for (const route of ["/", "/connections"]) {
  const response = await fetch(`https://platform.${domain}${route}`, {
    headers: { accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) throw new Error(`platform.${domain}${route} returned HTTP ${response.status}`);
}

console.log(`Production verification passed for ${domain}${expectedSha ? ` at ${expectedSha}` : ""}.`);
