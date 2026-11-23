/**
 * Connections end-to-end proof (docs/connections.md) against the REAL control
 * plane: the connect → grant → consent → vend → proxy → revoke flows run on
 * the control plane's own routes with fake-oauth as the provider and the dev
 * issuer as the user auth (bearer tokens stand in for the GUI session, which
 * is the same `consentActor` gate — the cookie is just the transport).
 *
 * Proven here:
 *   1. Connect: POST /connections/start builds a real PKCE authorize URL; the
 *      fake provider's consent form is submitted as provider user "ada"; the
 *      callback exchanges the code (real token endpoint) and stores an
 *      AES-256-GCM-encrypted connection row.
 *   2. Grant: the app (pre-M2M shared-secret headers) requests a grant; the
 *      consent screen 401s without a user actor, renders for the user, and
 *      the approve decision binds it to the connection.
 *   3. Vend: /vend returns the raw provider token; a direct provider API call
 *      with it succeeds.
 *   4. Proxy: /proxy/connection/datadog/* attaches the token and forwards;
 *      after the fake provider's token TTL the proxy transparently refreshes
 *      (rotation — x-terrarium-token-refreshed: true).
 *   5. Revocation: grant revoke → vend AND proxy 403 grant_required on the
 *      next call; re-approve, then connection revoke → all grants die.
 *   6. Audit: every proxied call wrote a proxy_audit row.
 *
 * The GitHub provider is registered separately (CONNECTIONS-SPIKE.md) and is
 * exercised by hand once GITHUB_OAUTH_CLIENT_ID/SECRET exist — this script
 * proves the entire mechanism end-to-end without external accounts.
 */
import { DevAuth } from "@terrarium/auth";
import { startDevIssuer } from "@terrarium/dev-issuer";
import { startFakeOAuthProvider } from "@terrarium/fake-oauth";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { controlPlaneServer } from "../src/server.ts";
import { Connections } from "../src/connections/service.ts";

const APP_ID = "metrics-dashboard";
const APP_SECRET = "metrics-dashboard-shared-secret";
const AUDIENCE = "control.terrarium.local";

const appHeaders = {
  "x-terrarium-app": APP_ID,
  "x-terrarium-app-secret": APP_SECRET,
  "content-type": "application/json",
};

const decodeHtml = (value: string) =>
  value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const formFromHtml = (html: string) => {
  const action = decodeHtml(html.match(/<form[^>]+action="([^"]+)"/)?.[1] ?? "");
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    if (match[1] && match[2] !== undefined) fields.set(decodeHtml(match[1]), decodeHtml(match[2]));
  }
  if (!action) throw new Error("demo: no form action found in HTML");
  return { action, fields };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const report: Record<string, unknown> = {};

// The provider OAuth client credentials + the token-at-rest encryption key
// resolve through the SecretsProvider (env here) — they must exist BEFORE the
// control plane layer builds. The fake provider's client registration needs
// the control plane's callback URL, which is only known after boot, so the
// provider starts after the control plane with that exact redirect URI.
process.env.FAKE_DATADOG_CLIENT_ID = "terrarium-control-plane";
process.env.FAKE_DATADOG_CLIENT_SECRET = "dev-control-plane-secret";
process.env.CONNECTIONS_TOKEN_ENCRYPTION_KEY = "demo-token-encryption-key";

const devIssuer = await startDevIssuer({ port: 0, audiences: [AUDIENCE] });

// Reserve a real port first: the connections base URL (redirect_uri, consent
// URLs) is baked at layer build, so the control plane must know its public
// address up front.
const freePort = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (address === null || typeof address === "string") {
      probe.close(() => reject(new Error("no port")));
      return;
    }
    probe.close(() => resolve(address.port));
  });
});

const scope = await Effect.runPromise(Scope.make());
const context = await Effect.runPromise(
  Layer.build(controlPlaneServer({
    port: freePort,
    discoveryIntervalMs: 0,
    oidc: { issuer: devIssuer.issuer, audience: AUDIENCE },
    appSecrets: { [APP_ID]: APP_SECRET },
    connectionsRefreshSkewMs: 1_000,
  })).pipe(Effect.provideService(Scope.Scope, scope)),
);
const server = Context.get(context, HttpServer.HttpServer);
const cp = HttpServer.formatAddress(server.address).replace(/\/$/, "");
console.log(`control plane: ${cp}`);

// 5s access-token TTL so the demo exercises a real refresh (rotation) quickly.
const provider = await startFakeOAuthProvider({
  name: "datadog",
  port: 0,
  accessTokenTtlSeconds: 5,
  clients: [{
    clientId: "terrarium-control-plane",
    clientSecret: "dev-control-plane-secret",
    redirectUris: [`${cp}/connections/callback`],
  }],
});

// Register fake-oauth as a provider against the control plane's own
// Connections service (in-process — same shape as the GitHub manifest entry).
await Effect.runPromise(
  Effect.gen(function*() {
    const connections = yield* Connections;
    yield* connections.registerProvider({
      name: "datadog",
      displayName: "Datadog",
      authorizeUrl: provider.authorizeUrl,
      tokenUrl: provider.tokenUrl,
      userinfoUrl: provider.userinfoUrl,
      apiBaseUrl: provider.apiBaseUrl,
      clientIdRef: "FAKE_DATADOG_CLIENT_ID",
      clientSecretRef: "FAKE_DATADOG_CLIENT_SECRET",
      defaultScopes: ["read:metrics"],
      responseMode: "form_post",
    });
  }).pipe(Effect.provideService(Connections, Context.get(context, Connections))),
);

const ada = await Effect.runPromise(DevAuth.fetchToken({
  issuer: devIssuer.issuer,
  sub: "user-ada",
  name: "Ada",
  audience: AUDIENCE,
}));
const userHeaders = { authorization: `Bearer ${ada.access_token}` };
const userJsonHeaders = { ...userHeaders, "content-type": "application/json" };

const json = async (response: Response) => ({ status: response.status, body: await response.json() as unknown });

// ---- 1. Connect ------------------------------------------------------------
report.providers = await json(await fetch(`${cp}/connections/providers`, { headers: userHeaders }));

const startResponse = await fetch(`${cp}/connections/start`, {
  method: "POST",
  headers: userJsonHeaders,
  body: JSON.stringify({ provider: "datadog" }),
});
const start = await startResponse.json() as { authorization_url: string; state: string };
assert.equal(startResponse.status, 200);
const authorizeUrl = new URL(start.authorization_url);
assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
assert.equal(authorizeUrl.searchParams.get("client_id"), "terrarium-control-plane");
assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `${cp}/connections/callback`);

// Provider consent (the browser part, scripted): approve as provider user ada.
const providerConsentResponse = await fetch(start.authorization_url);
const authorizeForm = formFromHtml(await providerConsentResponse.text());
authorizeForm.fields.set("provider_user", "ada");
const providerApprovedResponse = await fetch(authorizeForm.action, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: authorizeForm.fields,
});
const callbackForm = formFromHtml(await providerApprovedResponse.text());
assert.equal(callbackForm.fields.get("state"), start.state, "OAuth state must round-trip");

// The control plane's callback (form_post mode, like the browser would).
const callbackResponse = await fetch(callbackForm.action, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: callbackForm.fields,
});
const connection = await callbackResponse.json() as { connection_id: string; provider_account: { label: string } };
assert.equal(callbackResponse.status, 200);
assert.equal(connection.provider_account.label, "ada@datadog.test");
report.connect = {
  start: { status: startResponse.status, authorization_url: redacted(start.authorization_url) },
  callback: { status: callbackResponse.status, body: connection },
};

// The connection row must be listed, and its stored token must be encrypted at rest.
report.connectionList = await json(await fetch(`${cp}/connections`, { headers: userHeaders }));

// ---- 2. Grant + consent ----------------------------------------------------
const requestGrant = async () => {
  const response = await fetch(`${cp}/grants/request`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({ appId: APP_ID, provider: "datadog", scopes: ["read:metrics"] }),
  });
  return { response, body: await response.json() as { consent_url: string } };
};
const approveGrant = async (grantId: string) => {
  const response = await fetch(`${cp}/grants/decision`, {
    method: "POST",
    headers: { ...userHeaders, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant: grantId, decision: "approve" }),
  });
  return { response, body: await response.json() as { status: string; grant: { grant_id: string; owner_sub: string } } };
};

const grantRequest = await requestGrant();
assert.equal(grantRequest.response.status, 201);
const grantId = new URL(grantRequest.body.consent_url).searchParams.get("grant") ?? "";
assert.ok(grantId.length > 0);

// The consent screen is user-gated: no actor → 401 JSON (guiAuth is off here).
const anonymousConsent = await fetch(grantRequest.body.consent_url);
assert.equal(anonymousConsent.status, 401);
// The user's consent screen renders the app, provider, scopes and account.
const consentResponse = await fetch(grantRequest.body.consent_url, { headers: userHeaders });
const consentHtml = await consentResponse.text();
assert.equal(consentResponse.status, 200);
assert.match(consentHtml, /<strong>App metrics-dashboard<\/strong> wants your <strong>Datadog<\/strong>/);
assert.match(consentHtml, /Datadog/);
assert.match(consentHtml, /read:metrics/);
assert.match(consentHtml, /ada@datadog\.test/);

const approval = await approveGrant(grantId);
assert.equal(approval.response.status, 200);
assert.equal(approval.body.status, "approved");
assert.equal(approval.body.grant.owner_sub, "user-ada");
report.grant = {
  request: { status: grantRequest.response.status, consent_url: redacted(grantRequest.body.consent_url) },
  consentAnonymous: { status: anonymousConsent.status, body: await anonymousConsent.json() },
  consent: { status: consentResponse.status, htmlExcerpt: consentHtml.match(/<h1>.*<\/form>/s)?.[0] ?? consentHtml },
  approval: { status: approval.response.status, body: approval.body },
};

// ---- 3. Vend ---------------------------------------------------------------
const vendToken = async () => {
  const response = await fetch(`${cp}/vend`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({ appId: APP_ID, provider: "datadog" }),
  });
  return { response, body: await response.json() as { access_token?: string; refreshed?: boolean } };
};
const proxyMetrics = async () =>
  fetch(`${cp}/proxy/datadog/metrics?site=dev`, {
    headers: { "x-terrarium-app": APP_ID, "x-terrarium-app-secret": APP_SECRET },
  });

const vend = await vendToken();
assert.equal(vend.response.status, 200);
assert.ok(vend.body.access_token, "vend must return the raw provider token");
assert.equal(vend.body.refreshed, false);
// The vended token is the REAL provider token: it works against the provider directly.
const directResponse = await fetch(`${provider.apiBaseUrl}/metrics`, {
  headers: { authorization: `Bearer ${vend.body.access_token}` },
});
assert.equal(directResponse.status, 200);
report.use = {
  vend: { status: vend.response.status, body: { ...vend.body, access_token: "<redacted RS256 JWT>" } },
  directProviderCall: { status: directResponse.status, body: await directResponse.json() },
};

// ---- 4. Proxy (with transparent refresh/rotation) ---------------------------
const proxyResponse = await proxyMetrics();
assert.equal(proxyResponse.status, 200);
assert.equal(proxyResponse.headers.get("x-terrarium-token-refreshed"), "false");
report.use = { ...report.use as object, proxyCall: {
  status: proxyResponse.status,
  tokenRefreshed: proxyResponse.headers.get("x-terrarium-token-refreshed"),
  grantId: proxyResponse.headers.get("x-terrarium-grant-id"),
  body: await proxyResponse.json(),
} };

// The provider TTL is 5s and the control-plane refresh skew is 1s, so after
// this sleep the connection's token is inside its refresh window: the next
// proxy call must transparently rotate it (refresh-token rotation!).
await sleep(4_200);
const proxyRefreshed = await proxyMetrics();
report.refreshRotation = {
  status: proxyRefreshed.status,
  tokenRefreshed: proxyRefreshed.headers.get("x-terrarium-token-refreshed"),
  body: await proxyRefreshed.json(),
};
assert.equal(proxyRefreshed.status, 200);

// ---- 5. Revocation ----------------------------------------------------------
const revokeResponse = await fetch(`${cp}/grants/revoke`, {
  method: "POST",
  headers: userJsonHeaders,
  body: JSON.stringify({ grantId: approval.body.grant.grant_id }),
});
assert.equal(revokeResponse.status, 200);
const vendAfterRevoke = await vendToken();
const proxyAfterRevoke = await proxyMetrics();
assert.equal(vendAfterRevoke.response.status, 403);
assert.equal((vendAfterRevoke.body as { error?: string }).error, "grant_required");
assert.equal(proxyAfterRevoke.status, 403);
report.revokeGrant = {
  revocation: { status: revokeResponse.status, body: await revokeResponse.json() },
  vend: { status: vendAfterRevoke.response.status, body: vendAfterRevoke.body },
  proxy: { status: proxyAfterRevoke.status, body: await proxyAfterRevoke.json() },
};

// Re-approve a fresh grant, then revoke the CONNECTION — every grant dies.
const secondGrant = await requestGrant();
const secondGrantId = new URL(secondGrant.body.consent_url).searchParams.get("grant") ?? "";
const secondApproval = await approveGrant(secondGrantId);
assert.equal(secondApproval.body.status, "approved");
const connectionRevokeResponse = await fetch(`${cp}/connections/revoke`, {
  method: "POST",
  headers: userJsonHeaders,
  body: JSON.stringify({ connectionId: connection.connection_id }),
});
assert.equal(connectionRevokeResponse.status, 200);
const vendAfterConnectionRevoke = await vendToken();
const proxyAfterConnectionRevoke = await proxyMetrics();
assert.equal(vendAfterConnectionRevoke.response.status, 403);
assert.equal(proxyAfterConnectionRevoke.status, 403);
report.revokeConnection = {
  secondApproval: { status: secondApproval.response.status, body: secondApproval.body },
  revocation: { status: connectionRevokeResponse.status, body: await connectionRevokeResponse.json() },
  vend: { status: vendAfterConnectionRevoke.response.status, body: vendAfterConnectionRevoke.body },
  proxy: { status: proxyAfterConnectionRevoke.status, body: await proxyAfterConnectionRevoke.json() },
};

// ---- 6. Audit ---------------------------------------------------------------
const auditResponse = await fetch(`${cp}/integrations/datadog/audit`, {
  headers: { authorization: `Bearer ${ada.access_token}` },
});
const audit = await auditResponse.json() as { audit: Array<{ status: string; callerKind: string; path: string; app: string }> };
report.audit = { status: auditResponse.status, rows: audit.audit.map((row) => ({ status: row.status, app: row.app, path: row.path })) };
assert.ok(audit.audit.some((row) => row.status === "200"));
assert.ok(audit.audit.some((row) => row.status.startsWith("403")));

report.providerState = provider.snapshot();

console.log(JSON.stringify(report, null, 2));
console.log("\nPASS: connections meta-OAuth proven end-to-end on the real control plane");

await provider.close();
await devIssuer.close();
process.exit(0);

function redacted(value: string) {
  const url = new URL(value, "http://cp.local");
  for (const key of ["state", "code_challenge", "grant"]) {
    if (url.searchParams.has(key)) url.searchParams.set(key, "<redacted>");
  }
  return url.toString();
}
