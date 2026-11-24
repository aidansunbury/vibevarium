# Showcase ideas (internal — gitignored, keep local)

App/demo ideas that show off the platform's features without needing a real
company or real company data. Ordered roughly by "least data needed" to "most
plumbing."

> Status column: 💡 idea · 🚧 in progress · ✅ shipped.

## Zero-data / trivial

- 💡 **Demo-day signup form.** A plain form → a table. Needs nothing. Proves
  the boring loop: scaffold an app, it has a UI, it's on a custom domain, it
  has a real (D1) database. The "hello world" that shows a generated app is a
  real deployable thing, not a toy.

## Meta-OAuth (connections)

- 💡 **Project-management-lite over GitHub + Linear OAuth.** Connect GitHub
  (meta-OAuth) and Linear, then build a tiny cross-source board: GitHub issues
  on one side, Linear issues on the other, linked by title/label. Demonstrates
  the *whole point* — one OAuth flow per provider, the platform holds the
  tokens, the app reads both without ever owning a credential. The "we're not
  a company but have two real SaaS accounts" angle is exactly why this works
  for a solo demo.

## Credential proxy (the big one)

- 💡 **Read-only prod data access.** An app that answers *specific, pre-approved
  read queries* against a production database through the credential proxy —
  the app never sees the DB credential. Great for showing least-privilege data
  access.
- 💡 **Read-only prod access + PII redaction.** Same, but the proxy layer
  redacts PII columns before returning. Shows the proxy isn't just a pipe —
  it's a policy enforcement point. ("some good shit there" — redaction,
  allow-listed queries, row limits.)
- 💡 **Domain-record request approval.** The showcase app: an app lets users
  *request* a DNS record on a sensitive domain. An admin approves in the
  control-plane GUI. Only then does the platform use its sensitive Cloudflare
  token to create the record — **the app never holds the token.** This is the
  cleanest possible demo of the credential proxy's value: a powerful credential
  (domain DNS control) that the platform brokers with a human approval gate,
  and the app is provably unable to touch it directly.

## Other features worth a beat

- 💡 **Per-app secrets GUI.** Set an app's OpenAI key (or the Cloudflare token
  above) through the set-only secrets page — shows "you can see that a secret
  exists and replace it, never read it."
- 💡 **Preview deploys.** Open a PR against the demo app → a preview deploy
  spins up on its own hostname, torn down on close. Very visual.
- 💡 **Meta-MCP aggregation.** Point an agent at the platform meta-MCP and have
  it discover + call tools across two apps (e.g. the signup form + the project
  board) through one connection. Shows "every app is agent-callable by default."

## Notes

- The GitHub + Linear board and the domain-approval app are the two strongest
  "real feature" demos: they need nothing you don't already have (a GitHub
  account, a Linear account, the platform's own Cloudflare token).
