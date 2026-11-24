# Previews + App ACLs — working doc

Two workstreams, both **built and verified in prod** (2026-11-23).

**Prod e2e verified:** preview `tickets-pr-3` provisioned live via
`POST /apps/tickets/previews {pr:3}` → job stepper (repo → OIDC → deploy →
router → discover all `done`) → live at `https://tickets-pr-3.vibevarium.com`
(health 200, auth/status on), registered with preview lineage, listed in
`GET /previews?app=tickets`, history in `GET /apps/tickets-pr-3/history`.
The 7 `control_*` MCP tools are live on the prod meta-MCP; ACL routes respond.

**Real prod constraints hit (now documented):** the Cloudflare account has a
**10-database D1 limit** — previews must clean up stale `*-data` dbs or they
exhaust it. And the capability validator now counts boot-injected env
credentials in aws mode (was falsely reporting Cloudflare unbacked in prod).

**ACLs** Part 2 is built: the control plane owns the policy (store, service,
gated routes, GUI Access tab); enforcement at the app/router/gateway remains
the open decision.

---

## Part 1 — Preview deploys (Cloudflare-only)

### What a preview is

A PR-scoped, fully independent copy of an app: its own Worker, D1, hostname,
OIDC client, and proxy grants. Nothing shared with prod except the issuer.

```
app:        foo
preview:    foo-pr-42        (worker + stack name)
database:   foo-pr-42-data
hostname:   foo-pr-42.<domain>
stack:      vibevarium-foo-pr-42
```

The env-driven template makes this mechanical — `WORKER_NAME`,
`D1_DATABASE_NAME`, `STACK_NAME`, `APP_HOSTNAME`, `TERRARIUM_AUDIENCE` are env
overrides the deployer already sets.

### Lifecycle

- **Create/update** — a `preview` provision variant (same job engine, same
  stepper): materialize template with the PR name → deploy → preview OIDC
  client → register. Re-runs on new pushes to the PR.
- **Teardown** — on PR close (merged or not): destroy the stack, delete the
  OIDC client, drop router bindings/directory entries, delete preview-scoped
  proxy grants (keyed on the preview name). Same job UX, `teardown` job type.
  Total teardown is the point: Cloudflare per-app resources cost ~nothing and
  destroy cleanly.

### Data

- **D1: fresh + migrated** (default, shipped). Never clone prod data into a PR —
  slow, and copies real user data into preview infra. Seed scripts if a demo
  needs rows.
- Cloned prod data is permanently in the "too much work" bucket (if you need
  prod-real data, that's a *staging environment*, a different long-lived thing).

### Auth

- **Verification unchanged** — preview verifies the same platform JWKS/audience.
- **Browser login** — one preview OIDC client per preview (own redirect URIs),
  same `createOidcClient` seam as prod apps. Previews never share prod's client.
- **Access policy** — internal apps default: platform login is enough (the
  ACL work in Part 2 will refine "who can open previews" later; previews inherit
  the parent app's ACL).

### Proxy / integrations

- **Previews are separate apps to the proxy** — grants keyed on `foo-pr-42`,
  explicit only. No inheriting prod grants, ever (PR code must not touch prod
  user OAuth tokens).
- **Sandbox targets** — previews point integrations at sandbox/fake variants
  where available (fake-oauth, test accounts). Integration rows are cheap.

### Control-plane visibility (this pass)

- **Previews list** — per app (and globally): name, PR, status, URL, created,
  job status. Queryable from the registry (preview rows flagged) +
  provisioning jobs.
- **Deploy history** — provisioning/teardown jobs are already durable rows;
  expose them per app as the history view (spec, steps, outcome, timestamps).
  This is basically free from the job mechanism we just built.

---

## Part 2 — App ACLs (built)

### Requirements (from the ask)

1. App creator is an **admin** of that app. ✅ Seeded at provision time.
2. App visibility is a setting: **internal** (any platform user can access) or
   **restricted** (only named people). ✅ Per-app setting.
3. A **superadmin** tier: sensitive platform operations + default access to
   everything. ✅ Env seed + table, bypasses every ACL check.

### Where this lands in the doctrine

Identity tiers (docs/identity.md): token claims (Tier 0) → domain facts keyed
by `sub` (Tier 1) → rebuildable projection (Tier 2). **Permissions never on the
user row.** ACLs are Tier 1/2 material: the control plane owns them as facts.

Key existing fact: **each block authorizes itself** — apps verify and authorize
via their own middleware; no central point decides per-app permissions. ACLs
hold that line: the control plane *stores* the policy and enforces it on its
own GUI/API surface, but per-request enforcement at the app/router/gateway is
a separate, still-open decision (see "Still open" below).

### The model (as built — `packages/control-plane/src/store/schema.ts`)

```
app_acl:        app (pk → registry_apps), visibility ('internal'|'restricted'),
                created_by (sub, immutable creator seed), created_at, updated_at
app_acl_members: app (→ registry_apps), user_sub, role ('admin'|'member'),
                source ('local'|'external'), created_at, pk(app, user_sub)
platform_roles: user_sub (pk), role ('superadmin'), created_at
```

All three follow the store's idempotent `CREATE TABLE IF NOT EXISTS` boot-DDL
pattern (PGlite local dev, RDS prod) and cascade on app delete.

**The `source` column makes the model sync-ready.** Manual grants via the
GUI/API write `source='local'`. A future external directory sync (Okta groups
over SCIM) writes `source='external'` rows for the same (app, sub) pairs and
owns their lifecycle: the delete route refuses to remove `external` rows
(409 — "remove the grant at the source"), so a sync job never fights manual
local grants and vice versa. Okta itself is untested — the point is the rows
don't need to change when a sync lands.

### The service (`packages/control-plane/src/acl/index.ts`)

`Acl` — an Effect service over drizzle:

- `getAcl(app)` / `setVisibility(app, visibility)` / `listMembers(app)`
- `addMember(app, sub, role)` / `removeMember(app, sub)`
- `canAccess(app, sub)` — superadmin OR internal-visibility OR a member row.
  **Apps with no ACL row (legacy, pre-ACL registrations) default to
  internal** — any platform user passes; the row materializes on first
  mutation.
- `isAdmin(app, sub)` — superadmin OR an admin member row (the creator seed
  is an admin row).
- `isSuperadmin(sub)` — **two sources, either suffices**: the
  `TERRARIUM_SUPERADMINS` env var (comma-separated subs) and the
  `platform_roles` table (runtime grants via `grantSuperadmin`).
- `seedCreator(app, sub)` — idempotent: creates the ACL row (`created_by`
  set) and upserts the creator's admin member row. Called from the scaffold
  pipeline.

### Seeding the creator

The creator's `sub` comes from `CurrentActor`, provided on every gated route
(server.ts's gate: GUI session cookie OR bearer token). It travels as a plain
value, never through fiber boundaries implicitly:

- `POST /scaffold` route reads `CurrentActor` → `scaffold.create(name, preview, actorSub)`.
- `POST /provisioning` + `POST /apps/:name/previews` read `CurrentActor` →
  `provisioning.start(spec, actorSub)` → the background job fiber passes it to
  `scaffold.create` (the fiber doesn't inherit request context, hence the
  explicit parameter).
- `scaffold.create` → `register(...)` calls `acl.seedCreator(name, actorSub)`
  for prod apps. **Previews get no ACL rows — they inherit the parent app's
  ACL** (admin of parent = admin of previews), per the design question below.

### Routes (gated, `packages/control-plane/src/acl/routes.ts`)

Mounted under the same GUI-session-or-bearer gate as the ops routes
(`makeGated` in server.ts), so the TanStack GUI drives them with the cookie.

| Route | Gate |
| --- | --- |
| `GET /apps/:name/acl` | `canAccess(app, actor)` — 403 for non-members on restricted apps |
| `PUT /apps/:name/acl/visibility` | `isAdmin(app, actor)` |
| `POST /apps/:name/acl/members` | `isAdmin(app, actor)` |
| `DELETE /apps/:name/acl/members/:sub` | `isAdmin(app, actor)`; 409 on `source='external'` rows |
| `POST /platform/superadmins {sub}` | `isSuperadmin(actor)` — superadmins bootstrap superadmins |

When auth is disabled (local dev), there's no actor and every gate is open —
same posture as the rest of the control plane.

**Superadmin gate choices:** only `/platform/superadmins` is gated by
superadmin *directly* — it's the one truly platform-sensitive op here (it
grants the keys to everything). Per-app mutations are admin-gated, and
superadmins pass those checks through the bypass, which keeps "sensitive
platform ops" and "app administration" as distinct tiers. The MCP
`control_get_acl` tool (gateway/control-tools.ts) reads the same store.

### GUI

The app detail page (`/apps/:name`) has an **Access** tab: visibility toggle
(internal/restricted), member list with role + sync badges, add/remove member
(admin-only controls). Typed `api.ts` endpoints mirror the routes.

### Still open

- **Enforcement at the gateway/app (the real fork, unchanged from
  investigation).** This pass stores policy and enforces it on the control
  plane's own surface only. Per-request enforcement options remain: (a)
  gateway/proxy checks before forwarding `tools/call`, (b) apps fetch/cache
  the ACL and enforce in their own middleware (the read API for that is now
  `GET /apps/:name/acl`), (c) access claims in per-audience tokens. Likely (c)
  coarse + (b) of record + (a) for proxy calls. The router worker 403-ing
  restricted apps is optional defense-in-depth on top.
- **Okta/SCIM sync** — no sync job exists; the `source` column is the seam it
  writes through.
- **Directory-list filtering** — `GET /apps` / `GET /directory` still list
  every app to every platform user; hiding restricted apps from non-members
  in list views is a follow-up.
- **Teardown / preview-grant gating by app admin** — `DELETE /apps/:name` and
  preview creation are currently any-platform-user gated, not per-app-admin
  gated.
- **Superadmin GUI surface** — grants are API-only for now.
