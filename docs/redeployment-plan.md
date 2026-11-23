# Redeployment Plan — Casdoor auth, real secrets, authenticated MCP, previews

A clean rebuild of the deployment on the new topologies
([deployment-topologies.md](./deployment-topologies.md)), swapping Logto →
Casdoor, putting secrets in the right stores per target, and putting the MCP
behind auth for real. **Demo-scoped**: this is a proof of concept that must
*scale to* production, not a production migration.

Decisions locked with the team:

- **Clean rebuild** — tear down EC2/RDS/Logto, re-claim the domain, deploy
  fresh. No migration path (demo, not prod).
- **Pre-deploys for platform + apps** — apps already have per-PR previews; the
  platform gets them too.
- **App-secrets ACL = app owners/admins** — superadmins and the owning app's
  ACL members can list/set that app's secrets; matches the existing `app_acl`
  model.

## 1. Auth: Logto → Casdoor

**Why Casdoor** (the load-bearing claim, verified): Casdoor fully implements
**RFC 7591 (Dynamic Client Registration) + RFC 7592 (registration management) +
CIMD** (client-ID metadata documents). DCR is exactly what per-app OIDC client
registration needs at scaffold time — the seam that is Logto-specific today
([scaffold/logto.ts](../packages/control-plane/src/scaffold/logto.ts)).

- Endpoint: `POST {issuer}/api/oauth/register`; management at
  `/api/oauth/register/<client-id>` (GET/PUT/DELETE with the
  `registration_access_token`). Per-organization toggle (`dcrPolicy: open`).
- **Future-proof, not a compromise**: current MCP spec (2026-07-28) deprecates
  DCR in favor of CIMD but keeps DCR as a MAY for backward compat — and Casdoor
  supports **both**, so it covers today's DCR path and the CIMD forward path.
  Authentik was eliminated earlier for Enterprise-only authenticated DCR;
  WorkOS is config-validated but has no open self-hostable DCR.
- Self-hosted in Docker (Apache-2.0) on the same EC2 box as the control plane,
  backed by a `casdoor` database on the existing RDS instance (the
  one-instance-many-databases pattern — same instance already hosts
  `control_plane`).

**Work:**

- Deploy Casdoor container in
  [packages/infra/compose/docker-compose.yml](../packages/infra/compose/docker-compose.yml)
  + create the `casdoor` DB in the bootstrap script (alongside `control_plane`).
- Replace the Logto M2M Management-API adapter with a **Casdoor DCR adapter**
  behind the per-auth-provider seam: per-app OIDC client = one DCR call, not a
  console/admin API call. This is *simpler* than the Logto path (no M2M app to
  pre-create) and is the reason for the swap.
- Update capability config: `TERRARIUM_AUTH_PROVIDER=casdoor` becomes the real,
  deployable value; `logto` is removed (clean rebuild), `workos` stays
  config-validated-but-not-deployed.
- Point every flow's `issuer`/`audience` at the Casdoor discovery document.

## 2. MCP behind auth (for real)

The MCP gate ([gateway/mcp-gate.ts](../packages/control-plane/src/gateway/mcp-gate.ts))
is already code-side done and covered by `mcp-gate.test.ts`; in prod it is still
**unauthenticated** (state-of-the-project.md ⚠️). The Casdoor cutover is what
lets it ship:

- Public `/mcp` surface requires a valid bearer token (OIDC, issued by Casdoor).
- Gateway → child-app discovery uses an **M2M client-credentials** grant minted
  against Casdoor (replacing the static `DISCOVERY_TOKEN` placeholder and the
  Logto M2M app).
- Per-app MCP servers verify the caller's token against the same Casdoor
  issuer — the "one auth server for the whole fleet" property
  ([overview.md](./overview.md)) now holds with real enforcement, not a
  placeholder.

## 3. Secrets: the right store per target + a set-only GUI

**Platform secrets → AWS Secrets Manager** (already the case:
`SECRETS_PROVIDER=aws`, `/terrarium/prod/*` via the EC2 instance profile,
[integrations/secrets.ts](../packages/control-plane/src/integrations/secrets.ts)).
Keep, and extend for the GUI (below).

**Per-app secrets → the app's own cloud.** AWS app → AWS Secrets Manager;
Cloudflare app → **Worker secrets**. The control plane never holds app-secret
values; it writes them to the target store at provision/set time and the app
reads them from its own environment.

**Secrets GUI (set-only, never read-back):**

- Extend the `SecretsProvider` seam with `list()` + `put()` (the AWS layer uses
  `ListSecrets` + `PutSecretValue`/`CreateSecret`; the env layer stays
  read-only). This is a deliberate interface addition — today the seam is
  `resolve` only.
- **List names + provenance, never values** — the same trust model as the
  existing `/config-check` route, which already exposes key NAMES + source
  (`aws-secrets-manager` vs `env`), never values
  ([server.ts](../packages/control-plane/src/server.ts)).
- **Set new / overwrite**, no read-back: a write-only secret box. You can see
  *that* a secret exists and replace it; you can never retrieve the current
  value through the GUI. (AWS SM `GetSecretValue` is simply not called by the
  GUI path; the EC2 role's IAM policy can scope the GUI's write to
  `PutSecretValue` without `GetSecretValue` on the app-secret prefix.)
- **ACL**: platform secrets → superadmins; per-app secrets → superadmins + the
  owning app's ACL members (the locked decision). Enforced in the route layer
  against `app_acl` / `platform_roles`, not in the provider.

## 4. Pre-deploys (previews) for platform + apps

**Apps** — already built for Cloudflare
([previews-and-acl.md](./previews-and-acl.md)): per-PR Worker + D1 + hostname +
OIDC client. Extend to the new targets:

- **AWS app preview** → per-PR Lambda + RDS instance (instance-per-app, so a
  preview shares no blast radius with prod —
  [deployment-topologies.md](./deployment-topologies.md) §5a).
- **PlanetScale app preview** → per-PR branch (`empty` default / `--restore`
  copy opt-in — [planetscale.md](./planetscale.md) §4).
- App OIDC client for previews now comes from a **Casdoor DCR call** (no
  pre-provisioned client needed), which is *easier* than the Logto path.

**Platform** — new. A platform preview is a **full second stack per PR**:
control plane + its own Casdoor instance + its own `control_plane`/`casdoor`
databases + its own hostname. This is intentionally heavyweight and is why it
was a separate question from app previews:

- Runs on the same EC2 box as an additional docker-compose stack (a preview
  slot), not a new VPC.
- Gets its own subdomain (`platform-pr-N.<domain>`) and its own Casdoor org, so
  auth flows are testable end-to-end without touching prod auth.
- Its databases are fresh `control_plane_pr_N` / `casdoor_pr_N` schemas on the
  shared RDS instance (cheap, isolated enough for a preview).
- Torn down on PR close like app previews.

## 5. Sequencing (each independently landable)

1. **Casdoor on the box + DCR adapter** — auth swap is the unlock for
   everything else (MCP auth, preview OIDC clients).
2. **MCP behind auth** — flip the mcp-gate to enforced with Casdoor M2M.
3. **SecretsProvider `list`/`put` + set-only GUI** — platform secrets first,
   per-app secrets next (target-aware: SM for AWS apps, Worker secrets for CF).
4. **App previews on new targets** — AWS (Lambda+RDS) and PlanetScale
   (branch-per-PR) on top of the existing CF preview path.
5. **Platform pre-deploys** — the heavyweight last chunk.

Steps 1–2 are the "clean everything up, properly put MCP behind auth" core;
3–5 layer on secrets self-service and previews.

## 6. Honest caveats

- **Clean rebuild loses existing apps/registry.** Accepted — it's a demo.
  The domain is reclaimed and re-pointed.
- **Casdoor is one more always-on container** on the EC2 box (fine; the box is
  already always-on). It does not change the "no ECS for the platform" call.
- **Platform pre-deploys are the most expensive piece** and the least
  demo-critical; if scope has to shrink, #5 is the first thing to cut.
- **DCR is deprecated upstream** (in favor of CIMD) but is a MAY through at
  least mid-2027 and Casdoor supports both — so the DCR path is safe for the
  demo and the CIMD path is available when MCP clients move.
- **Set-only secrets GUI** still lets an attacker-with-admin-access *overwrite*
  a secret (availability risk), just not *read* it (confidentiality preserved).
  That's the right trade for a demo and matches cloud-console behavior.
