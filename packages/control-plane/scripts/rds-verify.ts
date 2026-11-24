/**
 * RDS swap verification — drives the live control plane end-to-end.
 *
 * Scripted Logto sign-in (the same Experience-API flow as logto-auth-demo.ts,
 * as user "clitest1") → session cookie → re-register tickets/notes → discover
 * → assert the registry rows persisted in RDS (via psql on the box, which is
 * the only host allowed to reach RDS) → restart the control-plane container →
 * assert the rows survived. That persistence across a restart is the entire
 * point of the PGlite → RDS swap.
 *
 * Not part of the repo's normal scripts — a one-shot ops verification for the
 * RDS cutover (see DB-SPIKE.md). Run locally:
 *
 *   LOGTO_GUI_APP_SECRET=… ssh -i … -N -L 15432:…:5432 box &   # not needed; psql runs on box
 *   tsx scripts/rds-verify.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const CP = "https://platform.vibevarium.com";
const SSH = ["-i", `${process.env.HOME}/Desktop/projects/vibevarium/.secrets/vibevarium-key.pem`, "-o", "ConnectTimeout=10", "ubuntu@107.23.2.162"];
const DB_URL = "postgres://postgres:JINp5H_vg%28LhqL0Ti%5Bv%28Xb%2927%2Ab%3C@terrariuminfra-postgres-live-aidan-a2whqelgnf35juwv.cctumyw2o6uz.us-east-1.rds.amazonaws.com:5432/control_plane";
const PSQL = `psql "${DB_URL}" -t -A -c`;
const USERNAME = "clitest1";
const PASSWORD = "Test!23456789a";

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

const ssh = (script: string) => execFileSync("ssh", [...SSH, script], { encoding: "utf8" }).trim();

// ── 1. Scripted sign-in → session cookie ─────────────────────────────────
console.log("== 1. Scripted Logto sign-in ==");
const jar = new CookieJar();
const loginPage = await fetch(`${CP}/auth/login`, { redirect: "manual" });
jar.absorb(loginPage);
const authorize = new URL(loginPage.headers.get("location")!);
const state = authorize.searchParams.get("state")!;
const authPage = await fetch(authorize, { redirect: "manual" });
jar.absorb(authPage);
jar.absorb(await fetch("https://auth.vibevarium.com/api/experience", {
  method: "PUT", headers: { "content-type": "application/json", cookie: jar.header() },
  body: JSON.stringify({ interactionEvent: "SignIn" }),
}));
const verify = await fetch("https://auth.vibevarium.com/api/experience/verification/password", {
  method: "POST", headers: { "content-type": "application/json", cookie: jar.header() },
  body: JSON.stringify({ identifier: { type: "username", value: USERNAME }, password: PASSWORD }),
});
jar.absorb(verify);
assert.equal(verify.status, 200, "password verification failed");
const { verificationId } = await verify.json() as { verificationId: string };
jar.absorb(await fetch("https://auth.vibevarium.com/api/experience/identification", {
  method: "POST", headers: { "content-type": "application/json", cookie: jar.header() },
  body: JSON.stringify({ verificationId }),
}));
const submit = await fetch("https://auth.vibevarium.com/api/experience/submit", {
  method: "POST", headers: { "content-type": "application/json", cookie: jar.header() },
});
jar.absorb(submit);
const { redirectTo } = await submit.json() as { redirectTo?: string };
let hop = await fetch(redirectTo!, { redirect: "manual", headers: { cookie: jar.header() } });
jar.absorb(hop);
let loc = hop.headers.get("location");
for (let i = 0; i < 5 && loc !== null && !loc.includes("/auth/callback"); i++) {
  const next = await fetch(new URL(loc, "https://auth.vibevarium.com"), { redirect: "manual", headers: { cookie: jar.header() } });
  jar.absorb(next);
  loc = next.headers.get("location");
}
const callbackUrl = new URL(loc!, CP);
const code = callbackUrl.searchParams.get("code")!;
const callback = await fetch(`${CP}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
  redirect: "manual", headers: { cookie: jar.header() },
});
jar.absorb(callback);
assert.equal(callback.status, 302, "callback should 302");
const me = await fetch(`${CP}/auth/me`, { headers: { cookie: jar.header() } });
assert.equal(me.status, 200);
console.log("   signed in as", JSON.stringify((await me.json()).actor));

const authed = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { cookie: jar.header(), "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

// ── 2. Re-register tickets + notes (the only pre-RDS rows) ───────────────
console.log("== 2. Re-register tickets + notes ==");
for (const name of ["tickets", "notes"]) {
  const res = await fetch(`${CP}/apps`, authed({ method: "POST", body: JSON.stringify({ name, url: `https://${name}.vibevarium.com/mcp` }) }));
  const body = await res.json() as { name: string; url: string };
  console.log(`   POST /apps ${name} → ${res.status}`, JSON.stringify(body));
  assert.ok(res.status === 201 || res.status === 200);
}

// ── 3. Discover → rows land in the registry ──────────────────────────────
console.log("== 3. Discover ==");
const discover = await fetch(`${CP}/discover`, authed({ method: "POST", body: "{}" }));
console.log(`   POST /discover → ${discover.status}`, JSON.stringify(await discover.json()).slice(0, 120));

// ── 4. Assert rows persisted in RDS (psql on the box) ────────────────────
console.log("== 4. Rows in RDS (via box psql) ==");
const rdsRows = ssh(`${PSQL} "SELECT name || ' | ' || url || ' | ' || status FROM registry_apps ORDER BY name"`);
console.log("   registry_apps:\n" + rdsRows.split("\n").map((l) => `     ${l}`).join("\n"));
const parsed = rdsRows.split("\n").filter(Boolean).map((l) => l.split(" | ")[0]);
assert.deepEqual(parsed, ["notes", "tickets"], "both apps must be in RDS");

// ── 5. Restart the container → rows survive (the whole point) ────────────
console.log("== 5. Restart control-plane → rows survive ==");
ssh("docker restart compose-control-plane-1");
console.log("   restarted; waiting for /health…");
let healthy = false;
for (let i = 0; i < 30 && !healthy; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  healthy = await fetch(`${CP}/health`).then((r) => r.ok).catch(() => false);
}
assert.ok(healthy, "control plane did not come back healthy");
console.log("   /health ok after restart");
// The in-memory GUI session dies with the container; assert persistence via
// psql (RDS is the store, not the session cache).
const rowsAfter = ssh(`${PSQL} "SELECT name || ' | ' || status FROM registry_apps ORDER BY name"`);
console.log("   registry_apps after restart:\n" + rowsAfter.split("\n").map((l) => `     ${l}`).join("\n"));
const namesAfter = rowsAfter.split("\n").filter(Boolean).map((l) => l.split(" | ")[0]);
assert.deepEqual(namesAfter, ["notes", "tickets"], "rows must survive the restart");
console.log("\nPASS: RDS persistence proven — registry rows survived a control-plane restart");
