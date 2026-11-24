# App Provisioning — platform capabilities, async jobs, and the setup wizard

How apps get provisioned: the **centralized capability config**, the
**job-based provisioning flow**, and the **click-through setup wizard**. This
builds on [providers.md](./providers.md) (everything is a provider) and
[state-of-the-project.md](./state-of-the-project.md).

## 1. Alchemy deployment targets (context)

Alchemy is the deploy substrate. Its first-party provider packages:

- **Cloudflare** (`@alchemy.run/cloudflare`) — deepest support (Workers, D1, R2,
  Hyperdrive, DO, …). **Our default.**
- **AWS** (`@alchemy.run/aws`) — Lambda, S3, etc.
- **GCP** (`alchemy/gcp`) — first-party and *broad* (Cloud Run, Cloud Functions,
  Storage, Firestore, Pub/Sub, SQL, …). Usable, less battle-tested than
  Cloudflare.
- **Azure** — **no first-party provider.** Reachable only indirectly
  (Kubernetes / Docker / Terraform escape hatches). Not a clean target.
- Plus non-"major-cloud" targets: Fly.io, Railway, Neon, Turso, PlanetScale,
  Docker, Kubernetes, Hetzner, DigitalOcean.

**Vibevarium answer:** Cloudflare and AWS are the clean "say AWS deployment or
Cloudflare deployment" targets. GCP is a credible third. Azure is a DIY gap.

> Doctrine (providers.md): deployment is **multi-target, not hot-swappable.** We
> guarantee a uniform *contract* — "an HTTPS endpoint that verifies OIDC
> tokens" — not uniform options. Cloudflare is the default because this app
> style fits Workers best; the point of the wizard is proving the platform is
> agnostic by making the target a *choice*.

## 2. Centralized capability config

One place decides which provisioning options are *on* and whether the platform
actually has the credentials to honor them. Schema-first, env-driven, validated
at boot. **Never stores secret values** — only that the required secret
references resolve (via the existing `SecretsProvider` seam).

```
TERRARIUM_DEPLOY_TARGETS=cloudflare,aws        # enabled targets (order = default first)
TERRARIUM_AUTH_PROVIDER=logto                  # logto | workos
TERRARIUM_DATABASE=cf-d1                        # cf-d1 | planetscale-hyperdrive
TERRARIUM_FEATURES=r2-hyperdrive                # optional feature flags
```

Each enabled option declares the config it **requires**; at boot we validate
those secrets resolve. An enabled-but-missing-credential option is a **boot
error** — you can't claim to support PlanetScale Hyperdrive without the
PlanetScale + Hyperdrive credentials. This is the "if you say it's supported,
prove it" rule.

Exposed to the wizard via **`GET /provisioning/options`** (gated): the enabled
targets/features/database/auth + which are credential-valid, so the GUI only
offers choices the platform can actually fulfill. See
[src/config](../packages/control-plane/src/config/index.ts).

| Option | Values | Default | Requires (validated) |
| --- | --- | --- | --- |
| Deploy target | `cloudflare`, `aws` | `cloudflare` | CF: `CLOUDFLARE_ACCOUNT_ID/ZONE_ID/WORKERS_SUBDOMAIN/ROUTER_KV_NAMESPACE_ID` + API token. AWS: AWS creds. |
| Storage / DB | `cf-d1`, `planetscale-hyperdrive` | `cf-d1` | hyperdrive: `CLOUDFLARE_HYPERDRIVE_ID` + `PLANETSCALE_HOST/USERNAME/PASSWORD/DATABASE` |
| Features | `r2`, `hyperdrive` | none | feature-specific |
| Auth server | `logto`, `workos` | `logto` | logto: `LOGTO_M2M_APP_ID/SECRET`. workos: `WORKOS_CLIENT_ID/API_KEY` |

### WorkOS as an auth-server provider

The auth boundary is **OIDC itself** (docs/auth.md) — the purest provider. WorkOS
AuthKit is an OIDC-compliant issuer, so "add WorkOS" is *config, not code*: point
`issuer`/`audience` at WorkOS's discovery document + JWKS. The only Logto-specific
machinery is the **M2M Management API** used to auto-register each app's OIDC
client at scaffold time ([scaffold/logto.ts](../packages/control-plane/src/scaffold/logto.ts))
— that lives behind a per-auth-provider seam so a WorkOS implementation can drop
in. `TERRARIUM_AUTH_PROVIDER=workos` + valid WorkOS creds selects it; until a
WorkOS client-registration adapter exists it validates as **configured but not
yet deployable** (honest, not silently broken).

## 3. Job-based async provisioning

`POST /scaffold` used to block 1–5 min while it created the repo, deployed,
registered the OIDC client, and ran discovery. Now it is a **job**:

```
POST /provisioning          { name, target?, database?, features? }  →  202 { jobId }
GET  /provisioning/:jobId    →  { jobId, name, status, steps[], result?, error? }
```

- Steps (repo → OIDC client → deploy → router binding → directory → discovery)
  run **server-side in a background fiber**; the POST returns immediately.
- Each job is a row in `provisioning_jobs` (Postgres/PGlite), so status
  **survives restarts** and the wizard can poll/resume.
- Each step records `pending | running | done | failed` (+ error). A failed job
  names the failed step; the wizard shows exactly where it stopped. Retry =
  resubmit the same spec (steps are idempotent by app name where possible).
- `DELETE /apps/:name` is unchanged (teardown stays synchronous).

This is the seam the wizard's **live stepper** reads: poll `GET
/provisioning/:jobId` and render steps as they flip to `done`. See
[src/provisioning](../packages/control-plane/src/provisioning/index.ts).

## 4. The setup wizard (`/scaffold`)

Replaces the single "app name + Scaffold button" box with a click-through flow
that only ever offers **validated** options (from `/provisioning/options`):

1. **Name** — DNS-label-safe, checked against the registry.
2. **Deployment target** — Cloudflare (default, "best fit") / AWS (if enabled).
3. **Storage** — D1 default; **PlanetScale Hyperdrive** if enabled+credentialed.
4. **Options** — feature checkboxes (R2 bucket, Hyperdrive) — only those enabled.
5. **Review** — the full spec before submitting.
6. **Provision** — submits to `POST /provisioning`, then a live stepper polls
   `GET /provisioning/:jobId` to the final app URL.

The wizard never lets you pick an option the platform can't back: disabled or
credential-invalid choices are hidden/greyed with the reason.

## 5. Template config building (better-t-stack reference)

The wizard's `target/database/features` answers are a **template config**.
[better-t-stack](https://github.com/AmanVarshney01/create-better-t-stack) (`bts`)
is the reference for turning such a config into a concrete project: a CLI that
composes a stack from discrete feature choices (web/native, backend, DB/ORM,
addons) instead of a fixed monorepo. Reference it for:

- **Conditional file selection** — emit the R2 / Hyperdrive bindings + env only
  when the corresponding feature is chosen, rather than shipping every binding
  commented-out.
- **Composition over templates** — one base template + feature fragments
  overlayed, vs. N near-duplicate templates. Matches the locked decision that
  "options are feature flags within a template, not new templates"
  (state-of-the-project.md).

Today the scaffold copies `packages/template-cloudflare` wholesale
([scaffold/template.ts](../packages/control-plane/src/scaffold/template.ts));
feature-aware materialization (bts-style overlays keyed off the wizard config)
is the follow-up. The `/provisioning` payload already carries the config that
would drive it.

## 6. Status / follow-ups

**Shipped (verified end-to-end):**

- ✅ **Centralized config** ([src/config](../packages/control-plane/src/config/index.ts)):
  every env var declared once via Effect `Config` (typed, defaulted); a bad
  value fails boot with one `ConfigError` (verified: `TERRARIUM_DATABASE=bogus`
  → `ConfigError: Expected "cf-d1" | "planetscale-hyperdrive"`). `main.ts` now
  consumes the parsed config instead of hand-rolled `process.env` reads.
- ✅ **Capability validation** — enabled options checked against resolvable
  credentials via the SecretsProvider seam; `/provisioning/options` serves the
  report (verified live).
- ✅ **Job-based provisioning** — `POST /provisioning` → `202 {jobId}`, durable
  `provisioning_jobs` row, background fiber flips step states, `GET
  /provisioning/:jobId` is pollable and **survives restarts** (verified). The
  route re-validates the spec (verified: unbacked Cloudflare → 503; AWS not
  enabled → 400; bad name → 400).
- ✅ **Click-through wizard** at `/scaffold` — Name → Target → Storage →
  Options → Review → live provisioning stepper; unbacked options are
  greyed/badged with their missing refs.
- ✅ **PlanetScale Hyperdrive** as a validated database option; **WorkOS** as a
  validated auth-server option; **AWS** as a validated deploy target.
- ✅ Gateway proof test still passes (no regression); control plane + web both
  typecheck/build clean.

**Honest follow-ups (concrete next chunks):**

- ⬜ **AWS deployer** — the target is validated + selectable and runs the job
  pipeline to a deliberate "not yet implemented" step; the real
  `@alchemy.run/aws` Lambda deployer is the next concrete chunk.
- ⬜ **Feature-aware template materialization** — today the scaffold copies
  `packages/template-cloudflare` wholesale; emitting R2/Hyperdrive bindings
  only when chosen (bts-style overlays) is the follow-up. The `/provisioning`
  payload already carries the config that would drive it.
- ⬜ **Real WorkOS Management-API adapter** for per-app OIDC client registration
  (WorkOS is config-validated as an auth provider; the registration adapter is
  the seam to fill).
- ⬜ **Granular in-pipeline step reporting** — the job currently reports coarse
  steps around the `Scaffold.create` pipeline; threading per-step progress
  through the pipeline itself sharpens the stepper.
