<p align="center">
  <img src="docs/branding/logo.svg" alt="the vibevarium mark — a glass vibevarium with a code-bracket sprout" width="96" height="96" />
</p>

<h1 align="center">vibevarium</h1>

<p align="center">
  <em>your enclosed little garden of apps — grown, not built.</em>
</p>

<p align="center">
  A platform where every vibe-coded app is a self-contained living world:<br/>
  its own repo, its own deploy, its own auth — all raised from one control plane.
</p>

---

## What grows here

One command (or one click) scaffolds a new app into the world: GitHub repo,
Cloudflare Worker + D1 deploy, custom domain, registered OIDC client, and
automatic discovery by the platform. Apps are grown from a single template —
React SPA + typed Effect backend — so the contract never varies, only the
starting shape.

- **Control plane** (`platform.vibevarium.com`) — provision, inspect, and prune
  apps; the meta-MCP aggregates every app's tools into one gateway.
- **Auth** — OIDC-only boundary; one platform token opens the gateway and
  every app, with per-app grants revocable in the control plane.
- **CLI** — the `vibevarium` binary composes app CLIs (and dynamically imports
  MCP tool schemas) so agents and humans share one interface.
- **Connections** — connect a provider once, vend per-app tokens through a
  unified credential-holding proxy, revoke with a cascade.

## Brand

The design system is **botanical print**: a field guide to your garden.
Fraunces serif display over Source Sans 3, squared letterpress edges,
hairline + double rules, laid-paper grain — in the **Vellum** (light) /
**Graphite** (dark) palette pair, WCAG-audited to AA/AAA.

Explorations and the audit live in [docs/branding](./docs/branding/):

- [vibevarium-brand-explorer.html](./docs/branding/vibevarium-brand-explorer.html) —
  interactive design-system explorer (palettes × edges × type × logos)
- [contrast-audit.mjs](./docs/branding/contrast-audit.mjs) — WCAG contrast
  audit (`node docs/branding/contrast-audit.mjs`)

The mark is a glass apothecary jar whose sprout leaves are `</>` — see
`@vibevarium/ui`'s `Logo` / `LogoLockup` components and
[docs/branding/logo.svg](./docs/branding/logo.svg).

## Layout

```
apps/                  grown + in-progress app instances
packages/
  control-plane/       the gardener: provisioning, registry, gateway, MCP
  template-cloudflare/ the starter seed every app grows from
  ui/                  design system (botanical-print theme, components)
  cli/                 the vibevarium binary
  infra/               AWS infrastructure (Alchemy)
  auth, connections/   platform services
docs/                  state of the project, decisions, brand
```
