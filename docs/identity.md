# Identity, roles, and authz in apps

The platform thesis: the auth server + control plane manage as much identity
infrastructure as possible, so an app is fully powered without writing its own
auth code. This doc is the doctrine for how apps handle users and permissions.

## The three tiers

An app slides right only when its queries demand it. Tiers 0 and 1 need zero
app-managed identity infrastructure.

### Tier 0 — the token is the user record

Roles are defined per API resource in the auth server (`admin`, `member` per
app), assigned via the control plane (talking to Logto's API), and delivered
as `scope` claims in the JWT. An app with simple RBAC checks claims in
middleware/`decide` and stores nothing.

Covers: per-app member/admin grants (the Zeus model), simple role checks.

### Tier 1 — domain facts keyed by `sub`

When users become domain nouns (ticket assignees, ownership, preferences),
those are facts in the app's own model keyed by the opaque `sub`:

- The auth server owns **identity**; the app owns **facts about what users did**
- The join key is `sub`; identity fields (email, name) are read from the
  source on demand, never mirrored as truth

### Tier 2 — rebuildable identity projection (opt-in)

When authz queries get complex (org hierarchies, per-resource ACLs, heavy
joins across identity), the app keeps a **local read-model of the identity
slice it needs** — a projection fed by platform events (Logto webhooks →
control plane → app) or lazy upsert. It is a cache: rebuildable, never the
source of truth. Later, the template ships this as a ready-made
`IdentityProjection` helper, so even Tier 2 is platform-managed.

## The anchor-row pattern (how apps FK to users)

Most apps want a `users` table for foreign keys. Correct — with discipline:

```sql
users (
  sub          text primary key,   -- the opaque id from the JWT
  display_name text,               -- cache, rebuildable
  updated_at   timestamp
)
```

- The row is an **anchor for FKs**, created lazily (JIT) the first time a
  valid token with that `sub` arrives. No sync job, no webhook needed for v1.
- Identity fields on it are **cache** — refreshable from token claims per
  request, or via webhook later.
- **Permissions never live on this row** (Tier 2 excepted, and then as a
  rebuildable projection). Source of truth for "what can this user do" stays
  in the auth server, delivered via token claims.

## Per-audience tokens (scopes across apps)

No JWT ever contains all of a user's permissions for all apps. Each app gets
its **own token** with its own audience and only the roles for that app.

Setup: two API resources — `tickets.vibevarium.com` (Ada is `admin`) and
`expenses.vibevarium.com` (Ada is `member`).

Ada logs into tickets — the token request names the resource (RFC 8707):

```json
{ "iss": "https://auth.vibevarium.com", "sub": "k2j4h5",
  "aud": "tickets.vibevarium.com",
  "scope": "openid profile admin read:tickets write:tickets" }
```

Ada opens expenses — no re-login (Logto's SSO session issues silently), but a
**different token**:

```json
{ "iss": "https://auth.vibevarium.com", "sub": "k2j4h5",
  "aud": "expenses.vibevarium.com",
  "scope": "openid profile member read:expenses" }
```

This is per-app grants made protocol-native, and it's why a leaked token
can't be replayed across apps: `aud` mismatch is a hard reject in
`@vibevarium/auth`.

**Meta-MCP wrinkle (open design question):** the gateway forwards the caller's
token to the child app, and the child checks `aud`. Options: multi-audience
tokens (`aud` as array), apps also accepting a shared platform audience, or
RFC 8693 token exchange at the gateway (same family as ID-JAG). Decide before
the gateway fronts authed apps in production.

## Webhooks (the "login callback" question)

Login produces **no callback** — apps verify tokens statelessly and never talk
to the auth server per request. Logto *does* have lifecycle webhooks
(`User.Created`, `SignIn`, …) via its Management API; the control plane can
consume them for platform-level reactions (e.g. provisioning on first signup)
or to feed Tier 2 projections. Apps that need per-user state do JIT creation
on first request instead — no event plumbing required.
