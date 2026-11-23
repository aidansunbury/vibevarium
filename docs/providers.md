# Providers

Every external service the platform touches sits behind a small interface with
swappable implementations. We ship defaults; anyone can implement the interface
for a custom backend. A few service-specific behaviors will always leak through
— that's fine. The goal is that *the rest of the system never changes* when an
implementation does.

## Git hosting

Owns: repo creation, scaffolding commits, branch/PR automation (for the
template and for future agent-driven migrations — Zeus's fleet-maintenance
lesson).

```ts
interface GitProvider {
  createRepo(name: string, template: Template): Repo;
  commit(repo: Repo, files: Files, message: string): void;
  openPullRequest(repo: Repo, branch: string, pr: PrSpec): PullRequest;
}
```

Implementations: GitHub first (there's an `@alchemy.run/github`), GitLab,
Gitea/self-hosted later.

## Secret stores

Owns: where app secrets live and how they reach the deployed app. The platform
writes secrets at scaffold time and never holds them itself.

```ts
interface SecretsProvider {
  put(app: AppId, key: string, value: Redacted<string>): void;
  get(app: AppId, key: string): Redacted<string>;
  list(app: AppId): string[];
  delete(app: AppId, key: string): void;
}
```

Implementations: AWS Secrets Manager, [Infisical](https://infisical.com),
HashiCorp Vault, Doppler, 1Password. (Alchemy already ships provider packages
for several of these.)

## Auth server

Already covered in [auth.md](./auth.md). The interface is **OIDC itself** —
discovery document, JWKS, standard flows — not a vendor abstraction we wrote.
This is the purest of the providers: there is no `AuthProvider` interface to
implement, only an issuer URL and audience in config.

## Deployment — multi-target, not "pluggable"

Deployment is the one provider where *pluggable* is the wrong frame. You can't
swap a Cloudflare Worker for a Lambda and keep every option — feature parity
across clouds is neither possible nor the goal. What the platform guarantees is
a uniform **contract**, not uniform options:

```ts
interface DeploymentTarget {
  deploy(app: AppId, stack: Stack): { url: string };
  env(app: AppId, vars: Record<string, string | Redacted<string>>): void;
  logs(app: AppId): LogStream;
  destroy(app: AppId): void;
}
```

- **Start with Cloudflare** (Workers — and the domain model already hosts on
  Cloudflare Durable Objects, Rivet, or Effect Cluster), **AWS next** (Lambda).
- Target-specific options live in the app's own alchemy stack and are allowed
  to differ. The platform doesn't hide them behind a fake
  lowest-common-denominator abstraction.
- Everything above the contract — discovery, auth, MCP aggregation, the CLI —
  depends only on what the contract produces: **an HTTPS endpoint that verifies
  OIDC tokens**. Whether that's a Worker or a Lambda is invisible to the rest
  of the system.

The uniformity comes from the wire contract, not from abstracting the clouds.

## Alchemy as the substrate

The platform itself is built on [Alchemy](https://alchemy.run): one stack per
app gives us deploy + env + destroy per target, and its provider packages
(`@alchemy.run/cloudflare`, `@alchemy.run/aws`, `@alchemy.run/infisical`,
`@alchemy.run/github`, …) are ready-made implementations for several of the
interfaces above. Alchemy also ships first-party **GCP** (`alchemy/gcp` —
Cloud Run/Functions/Storage/…, broad but less battle-tested than Cloudflare);
there is **no first-party Azure** provider (reachable only via the
Kubernetes/Docker/Terraform escape hatches). See
[provisioning.md](./provisioning.md) for how the platform picks and validates a
deploy target per app.
