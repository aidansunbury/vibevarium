# Glossary

- **App** — an application. Independently deployed at `appname.yourdomain.com`;
  generated from a template; exposes its own MCP server.
- **Control plane** — the central server. Spins up new apps, holds proxied
  credentials that apps never get direct access to, runs discovery, and hosts
  the meta-MCP gateway that aggregates every app's tools.
- **Auth server** — the central OIDC provider. The only auth interface the
  platform and apps depend on; swappable (see [auth.md](./auth.md)).
- **Template** — the scaffold an app is generated from. Encodes every platform
  decision (domain skeleton, auth middleware, MCP hosting, deploy stack) so app
  authors never answer a configuration question. One for now; several
  eventually, varying the starting shape but never the contract.
