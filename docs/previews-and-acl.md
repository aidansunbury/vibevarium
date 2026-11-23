# Previews + App ACLs — working doc

Two workstreams. **Previews** is being built now (Cloudflare-only first pass).
**ACLs** is investigation-only — this doc captures the design space so the
implementation pass doesn't start from zero.

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
stack:      terrarium-foo-pr-42
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

## Part 2 — App ACLs (investigation, not built)

### Requirements (from the ask)

1. App creator is an **admin** of that app.
2. App visibility is a setting: **internal** (any platform user can access) or
   **restricted** (only named people).
3. A **superadmin** tier: sensitive platform operations + default access to
   everything.

### Where this lands in the doctrine

Identity tiers (docs/identity.md): token claims (Tier 0) → domain facts keyed
by `sub` (Tier 1) → rebuildable projection (Tier 2). **Permissions never on the
user row.** ACLs are Tier 1/2 material: the control plane owns them as facts,
projects them into tokens or checks them at the edge.

Key existing fact: **each block authorizes itself** — apps verify and authorize
via their own middleware; no central point decides per-app permissions. ACLs
must not break that: the control plane *stores* the policy, but enforcement
belongs to the app/router/gateway at request time.

### The model (sketch)

```
app_acl:
  app        text        -- app name
  visibility text        -- 'internal' | 'restricted'
  created_by text        -- sub of the creator (immutable admin seed)

app_acl_members:
  app        text
  user_sub   text
  role       text        -- 'admin' | 'member'
```

- Creator → `admin` row at provision time (the scaffold already knows the
  actor from the session).
- `internal` = any authenticated platform user passes. `restricted` = member
  list check.
- Admin capabilities (per app): manage members, change visibility, teardown,
  manage preview grants. Member: access.
- **Superadmin**: a platform-level role (not per-app) — bypasses every ACL
  check + gates sensitive platform ops (config changes, superuser-y routes).

### Open design questions to resolve before building

1. **Where does enforcement happen?** Options:
   - (a) **Gateway/proxy-level** — the gateway checks the ACL before proxying
     `tools/call` or proxy requests. Centralizes enforcement for
     machine-access, but not browser access.
   - (b) **App-level** — apps fetch/cache the ACL and enforce in their own
     middleware (true to "each block authorizes itself"). Needs a control-plane
     read API for ACLs.
   - (c) **Token claims** — platform issues tokens carrying an app-access
     claim; apps just check the claim. Simplest enforcement, but claims go
     stale on revocation (needs short TTLs or introspection).
   - Likely: (c) for coarse gating + (b) as the check of record, with (a) for
     proxy calls. This is the biggest decision.
2. **Superadmin storage** — env list of subs? A `platform_roles` table? Logto
   role claim mirrored? (Env seed + table override is the pragmatic spike.)
3. **Does the router worker need to know?** The wildcard router could 403
   restricted apps before the request even reaches the app Worker — nice
   defense-in-depth, optional.
4. **Preview ACLs** — inherit parent app's ACL (proposed default). Admin of
   parent = admin of previews.
5. **GUI** — an "Access" tab per app (visibility toggle, member list,
   add/remove) + a superadmin settings surface.

### What "looking at it" produced (this doc)

- The data model above fits cleanly into the existing store (two tables,
  mirrors integrations/grants shape).
- Enforcement question (Q1) is the real fork; the rest is plumbing.
- Superadmin is small: a role source + a check at sensitive routes + ACL bypass.
- Previews inherit parent ACL — no new model needed.
- Provision-time seeding: creator → admin row in the scaffold pipeline.
