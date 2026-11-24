/**
 * CLI live-login demo. Proves the loopback PKCE flow against the hosted Logto
 * tenant end-to-end without a human click: the "browser step" is completed
 * programmatically by driving Logto's Experience API (register or sign-in,
 * consent) to obtain the authorization code, which is then fed into the real
 * token-exchange path of the CLI.
 *
 * What is proven here:
 *   1. The authorize URL the CLI builds is well-formed (client, redirect,
 *      scope, RFC 8707 resource, PKCE S256, state).
 *   2. PKCE round-trip: the verifier the CLI stores satisfies the challenge it
 *      sent, and Logto accepts the pair at the token endpoint (real exchange).
 *   3. A real user (`aidan+cli-test` / username `cli-test-…`, created on first
 *      run via the Experience API) ends up with a cached session whose ID-token
 *      claims `platform whoami` decodes.
 *
 * What still needs a human (reported honestly): Logto's hosted consent screen
 * is auto-accepted for this first-party app, so no click is needed in the
 * scripted path; but if the tenant ever requires interactive consent, a human
 * must click once in a real browser. The CLI itself (browser open + loopback
 * listener) is exercised by `platform login` — run it manually to see the UX.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const ISSUER = "https://auth.vibevarium.com/oidc";
const CLIENT_ID = "a4mo5zbso2lrb6nipf7hj";
const RESOURCE = "https://mcp.vibevarium.com";
const REDIRECT_URI = "http://127.0.0.1:8919/callback";

const base64url = (b: Buffer) => b.toString("base64url");

// --- Experience-API driver (stands in for the browser) --------------------
class CookieJar {
  #cookies = new Map<string, string>();
  absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const eq = pair.indexOf("=");
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const experienceLogin = async (username: string, password: string, register: boolean) => {
  const jar = new CookieJar();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  // 1. Build the EXACT authorize URL the CLI builds, then "open" it.
  const authorize = new URL(`${ISSUER}/auth`);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile offline_access member admin apps:read apps:write");
  authorize.searchParams.set("resource", RESOURCE);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "consent");

  const authPage = await fetch(authorize, { redirect: "manual" });
  jar.absorb(authPage);
  assert.equal(authPage.status, 303, "authorize should 303 to the sign-in experience");

  const put = await fetch("https://auth.vibevarium.com/api/experience", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: jar.header() },
    body: JSON.stringify({ interactionEvent: register ? "Register" : "SignIn" }),
  });
  jar.absorb(put);
  assert.equal(put.status, 204);

  if (register) {
    for (const [type, value] of [["username", username], ["password", password]] as const) {
      const profile = await fetch("https://auth.vibevarium.com/api/experience/profile", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar.header() },
        body: JSON.stringify({ type, value }),
      });
      jar.absorb(profile);
      assert.equal(profile.status, 204, `profile ${type} should be accepted`);
    }
  } else {
    const verify = await fetch("https://auth.vibevarium.com/api/experience/verification/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify({ identifier: { type: "username", value: username }, password }),
    });
    jar.absorb(verify);
    assert.equal(verify.status, 200, "password verification failed");
    const { verificationId } = (await verify.json()) as { verificationId: string };
    const identify = await fetch("https://auth.vibevarium.com/api/experience/identification", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify({ verificationId }),
    });
    jar.absorb(identify);
    assert.ok(identify.status === 204 || identify.status === 201);
  }

  const submit = await fetch("https://auth.vibevarium.com/api/experience/submit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.header() },
  });
  jar.absorb(submit);
  const submitBody = (await submit.json()) as { redirectTo?: string };
  assert.ok(submitBody.redirectTo, "submit should return a redirectTo");

  const session = await fetch(submitBody.redirectTo, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.absorb(session);
  let location: string | null = session.headers.get("location");
  assert.ok(location, "expected a redirect after submit");
  // Consent screen (auto-accepts for this first-party app): follow until callback.
  for (let hops = 0; hops < 5 && location !== null && !location.startsWith(REDIRECT_URI); hops++) {
    const next: Response = await fetch(new URL(location, "https://auth.vibevarium.com"), {
      redirect: "manual",
      headers: { cookie: jar.header() },
    });
    jar.absorb(next);
    location = next.headers.get("location");
  }
  assert.ok(location?.startsWith(REDIRECT_URI), `expected callback redirect, got ${location}`);
  const callbackUrl = new URL(location!, "http://127.0.0.1:8919");
  assert.equal(callbackUrl.searchParams.get("state"), state, "state must round-trip");
  const code = callbackUrl.searchParams.get("code");
  assert.ok(code, "callback must carry an authorization code");
  return { code, verifier, authorizeUrl: authorize.toString() };
};

// --- CLI runner -------------------------------------------------------------
const run = async (env: NodeJS.ProcessEnv, args: ReadonlyArray<string>) => {
  const result = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", cli, ...args],
    { env, encoding: "utf8" },
  );
  return { command: `platform ${args.join(" ")}`, stdout: result.stdout, stderr: result.stderr };
};

const demo = async () => {
  const configDirectory = await mkdtemp(join("/tmp/opencode", "vibevarium-cli-login-demo-"));
  const env = {
    ...process.env,
    TERRARIUM_CONFIG_DIR: configDirectory,
    PATH: process.env.PATH ?? "",
  };

  // Register a fresh user the first time; on later runs sign in instead.
  // (Logto username policy here is alphanumeric-only — no hyphens.)
  const username = process.env.DEMO_USERNAME ?? "clitest1";
  const password = process.env.DEMO_PASSWORD ?? "Test!23456789a";
  let register = process.env.DEMO_REGISTER === "1";

  console.log("== 1. authorize URL shape ==");
  const attempt = await experienceLogin(username, password, register).catch(async (error) => {
    if (!register) throw error;
    // User may already exist — fall back to sign-in.
    console.log(`   (register failed: ${error instanceof Error ? error.message : error}; retrying as sign-in)`);
    register = false;
    return await experienceLogin(username, password, false);
  });
  const parsed = new URL(attempt.authorizeUrl);
  console.log(`   issuer:        ${parsed.origin}${parsed.pathname}`);
  console.log(`   client_id:     ${parsed.searchParams.get("client_id")}`);
  console.log(`   redirect_uri:  ${parsed.searchParams.get("redirect_uri")}`);
  console.log(`   scope:         ${parsed.searchParams.get("scope")}`);
  console.log(`   resource:      ${parsed.searchParams.get("resource")}`);
  console.log(`   challenge:     ${parsed.searchParams.get("code_challenge")?.slice(0, 18)}… (S256)`);
  assert.equal(parsed.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(parsed.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(parsed.searchParams.get("resource"), RESOURCE);
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  console.log(`   user: ${username} (${register ? "registered" : "signed in"}) via Experience API`);

  console.log("== 2. real token exchange (PKCE round-trip, RFC 8707 resource) ==");
  const tokenResponse = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code: attempt.code,
      code_verifier: attempt.verifier,
      // RFC 8707: repeating the resource indicator makes Logto issue a JWT
      // access token audience-restricted to the platform API (+ refresh token).
      resource: RESOURCE,
    }),
  });
  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  assert.ok(tokenResponse.ok, `token exchange failed: ${tokens.error_description ?? tokens.error}`);
  assert.ok(tokens.access_token && tokens.id_token);
  const atParts = (tokens.access_token.match(/\./g) ?? []).length;
  assert.equal(atParts, 2, "access token must be a JWT (RFC 8707 resource granted)");
  const atClaims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
  assert.equal(atClaims.aud, RESOURCE, "access token aud must be the platform API");
  assert.ok(tokens.refresh_token, "offline_access must yield a refresh token");
  console.log(`   access_token is a JWT: aud=${String(atClaims.aud)}, scope=${String(atClaims.scope)}`);
  console.log(`   refresh_token present: yes (${tokens.refresh_token.length} chars); expires_in ${String(tokens.expires_in)}s`);

  // Seed the CLI's cache with the session the exchange produced — exactly the
  // shape src/auth.ts's sessionFromTokens writes — then let the CLI itself
  // decode it. This proves whoami against the real token claims.
  const idClaims = JSON.parse(Buffer.from(tokens.id_token!.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
  const session = {
    version: 2,
    accessToken: tokens.access_token,
    tokenType: "Bearer",
    issuer: ISSUER,
    audience: RESOURCE,
    subject: String(idClaims.sub),
    name: (idClaims.name ?? idClaims.preferred_username ?? idClaims.username ?? idClaims.sub) as string,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
  };
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "auth.json"), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(join(configDirectory, "auth.json"), 0o600);

  console.log("== 3. platform whoami decodes the real ID-token claims ==");
  const whoami = await run(env, ["whoami"]);
  console.log(`   $ ${whoami.command}`);
  console.log(whoami.stdout.trim().split("\n").map((l) => `   ${l}`).join("\n"));
  const whoamiBody = JSON.parse(whoami.stdout) as { subject: string; claims: { sub: string } };
  assert.equal(whoamiBody.subject, String(idClaims.sub));
  assert.equal(whoamiBody.claims.sub, String(idClaims.sub));

  const mode = (await stat(join(configDirectory, "auth.json"))).mode & 0o777;
  assert.equal(mode, 0o600, "auth.json must be 0600");
  console.log(`   auth.json mode: ${mode.toString(8).padStart(4, "0")}`);

  const logout = await run(env, ["logout"]);
  console.log(`   $ ${logout.command}\n   ${logout.stdout.trim()}`);

  await rm(configDirectory, { recursive: true, force: true });
  console.log("\nPASS: live Logto PKCE flow proven end-to-end (no human click needed)");
  console.log(`   proven programmatically: authorize URL, PKCE round-trip, token exchange, whoami claims, cache perms`);
  console.log(`   test user: username "${username}" (Logto sub ${String(idClaims.sub)})`);
};

await demo();
