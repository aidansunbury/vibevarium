# Vibevarium

A platform for fleets of small, independently-deployed company apps ("vibe-coded
apps") where every app is **agent-callable by default**: each app exposes its own
MCP server, and a central gateway aggregates them into one discovery directory
behind one auth server.

**Everything is a provider.** Every external service the platform touches — git
hosting, secret stores, auth, deployment — sits behind a small interface with
swappable implementations (or a custom one written against the interface). A few
service-specific behaviors will always leak, but the rest of the system never
changes when an implementation does. See [providers.md](./providers.md).

## The problem

Inspired by [Zeus](https://building.owner.com/zeus) (Owner.com's internal app
platform). Zeus solves auth, hosting, databases, and CI for ~600 internal apps —
but its batteries are all *inbound*: centralized services apps call into (a data
proxy, an inference router, Slack/email). There is no story for an app to publish
a *contract back up* to the platform. An app that wants to be callable by agents
has to hand-roll its own MCP server and its own auth verification.

Zeus can't retrofit this: it grew organically, so its apps have no common
contract shape. Starting from scratch is the advantage — we can make "every app
publishes a typed contract" a property of the app template, not a migration.

## The idea

- **Central auth server** — a standalone OIDC provider (not built by us, and
  swappable — see [auth.md](./auth.md)).
- **Central gateway ("meta-MCP")** — an MCP server that discovers all known
  child apps, aggregates their tool lists into one directory, and proxies
  `tools/call` to the right child, forwarding the caller's credentials.
- **Child apps** — independently deployed, each built on
  [`@alchemy.run/domain`](https://alchemy.run/domain). The app's MCP server,
  HTTP API, CLI subtree, and typed client are **derived from one Api
  declaration**, not implemented separately. See [architecture.md](./architecture.md).
- **One domain for everything** — every app lives at `appname.yourdomain.com`.
  One wildcard DNS record + one wildcard cert covers the whole fleet; a company
  only needs a single domain for all its apps, present and future.
- **Templates encode every decision** — apps are generated from a template
  (Effect + Drizzle backend, React frontend). One template for now; more later.
  See [stack.md](./stack.md).
- **Fault isolation** — every app deploys and dies alone. A dead child never
  breaks discovery (the directory serves last-known-good) and never breaks calls
  to other children.

## Why greenfield matters

Because nothing exists yet, we can mandate: **every app is a domain app**. The
"generate app" scaffold emits a repo where the domain skeleton, session
middleware, and MCP/HTTP hosting are pre-wired. The app author writes commands
and queries; every client surface falls out. The contract-back-to-the-platform
stops being something apps *do* and becomes something they *can't avoid*.

## Design principles

1. **Everything is a provider.** Git hosting, secrets, auth, deployment — each
   is an interface with swappable implementations. The platform core depends on
   contracts, never on a vendor. See [providers.md](./providers.md).
2. **The contract is the code.** An app's MCP tools, OpenAPI doc, and CLI flags
   all derive from the same schema'd declarations. They cannot drift.
3. **OIDC is the only auth interface.** No vendor SDKs anywhere. Any compliant
   provider (or WorkOS/Clerk later) is a config swap. See [auth.md](./auth.md).
4. **Serve discovery from a store, not a live fan-out.** A fleet of vibe-coded
   apps always has one down. "Directory is stale for one app" beats "discovery
   times out".
5. **Each block authorizes itself.** The gateway forwards credentials; children
   verify and authorize via their own middleware. No central point decides
   per-app permissions.
6. **Start small.** Zeus's own lesson: ship the batteries people need first
   (template + derived MCP + auth middleware), let the meta-gateway start as a
   registry + proxy over a static config.
