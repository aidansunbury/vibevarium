# Stack

The platform's job is to **decide once, decide well, and encode the decision in
the template** — so app authors never answer a configuration question.

Zeus's key insight applies here: when people build with AI agents, they stop
caring about "tech" choices — and often stop reading the code entirely. What
they need is a starting point where the choices are already made and already
correct. The best thing the platform can do is set people up from the start.

## Backend: Effect + Drizzle

- The **platform itself** (gateway, registry, scaffolding) is built with
  [Effect](https://effect.website) — and the domain layer on
  [`@alchemy.run/domain`](https://alchemy.run/domain), which is Effect-native.
- The **apps** are also Effect + [Drizzle](https://orm.drizzle.team). The
  template wires Drizzle to the app's provisioned database; the app's domain
  code stays pure (`@alchemy.run/domain` + `effect` only) so infrastructure
  lives where it belongs. (Alchemy has a `@alchemy.run/drizzle` integration for
  provisioning + migrations.)

## Frontend: React, for the ecosystem above all else

Not because React is the best framework on any technical axis, but because the
ecosystem — component libraries, examples, agent training data — is the
deepest moat there is. When an AI agent writes most of the code, "what the
agent writes best" *is* the technical argument. React wins that outright.

Whether the frontend framework even matters much is an open question — the
React decision is cheap precisely because the ecosystem makes it the default
either way.

## Toolchain

- **Type checking: [tsrs](https://oxc.rs/blog/2026-11-17-faster-type-aware-linting-with-tsrs)**
  (the Rust port of the TypeScript 7 compiler) for the control plane and every
  template, plus **type-aware linting** (oxlint on tsrs type info). Fast enough
  that full type checking is part of the inner loop, not CI-only. Same choice
  Alchemy itself made.
- **Package manager / runtime: undecided** — pnpm vs bun, node vs bun. Don't
  decide yet; keep both paths working in the template until something forces
  the call.
- **[Bun AOT compilation](https://bun.com/docs/compiler/aot): maybe eventually.**
  Single-file binaries would be a nice distribution story for the platform CLI.
  Not yet — and it should stay easy to swap in, so nothing in the codebase may
  assume a specific runtime or module loader.

## Templates

- **One template for now**: Effect + Drizzle backend, React frontend, domain
  skeleton, session middleware, MCP/HTTP hosting pre-wired, alchemy deploy
  stack.
- **Eventually several**: different starting points for different app shapes
  (a dashboard app, a CRUD app, a scheduled-job app, …). Each template still
  encodes *all* platform contracts — an app from any template is a domain app
  with a derived MCP server. Templates vary the starting shape, never the
  contract.

Zeus shipped TanStack Start or Astro; the framework per template is a detail.
What can't vary is what the platform depends on: the domain package, the Api
declaration, the auth middleware.
