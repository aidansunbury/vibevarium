# Integration proxy spike (`src/integrations/`)

> The v1 of [docs/connections.md](../../docs/connections.md)'s proxy model:
> shared company credentials the control plane holds and apps never see.

## Verdict

`POST /proxy/:integration/*` works end to end: an app presents the pre-M2M
placeholder credential (app-id + shared secret), the control plane checks its
app × integration grant row, resolves the integration's real token **from an
env var** (the v1 secrets backend), attaches it as `Authorization: Bearer`,
forwards method/body, and returns the upstream response. Every call writes a
`proxy_audit` row. Revoking the grant is a row delete; the very next call gets
`403 grant_required`. User-context proxying (a caller's OIDC bearer token) also
works, keyed to the app named by `x-vibevarium-on-behalf-of-app`.

Proof: `pnpm --filter @vibevarium/control-plane proxy:demo` boots a dev issuer,
a fake "snowflake" API, and the control plane (auth on), then asserts the whole
grant → proxy → audit → revoke → 403 round trip. Excerpt:

```json
"tokenSeenByFakeApi": { "path": "/v1/query", "authorization": "Bearer snowflake-real-token-abc123" }
"callAfterRevoke": { "status": 403, "body": { "error": "grant_required" } }
```

## Data model (PGlite, idempotent DDL in `src/store/database.ts`)

- `integrations` — name (PK), `base_url`, `token_env`, `auth_header`
  (`authorization_bearer | authorization | x-api-key | none`), `timeout_ms`,
  `created_at`. The row never holds the token value, only the env var name.
- `integration_grants` — `(app, integration)` PK, FK cascade on integration.
  Revoke = flip/delete a row, executor-style.
- `proxy_audit` — id, `at`, `caller_kind` (user|app), `caller`, `app`,
  `integration`, `method`, `path`, `status` (upstream status, or
  `403 grant_required` / `502 secret_unavailable` / `504`), `duration_ms`.
  The `grant_required` rows are recorded too — denied calls are exactly what an
  audit log is for.

## Admin endpoints (auth-gated when `CONTROL_PLANE_ISSUER` is set)

- Static definitions come from `config/connections.config.ts`; there is no
  integration-definition CRUD API.
- `GET /integrations`, `GET /integrations/grants`,
  `POST/DELETE /integrations/:name/grants(/:app)`
- `GET /integrations/:name/audit?limit=50`

## Caller auth on `/proxy/*` — the auth seams

1. **User-context**: a valid `@vibevarium/auth` bearer token (dev-issuer today;
   Logto hosted flow later — the config seam is `CONTROL_PLANE_ISSUER` /
   `CONTROL_PLANE_AUDIENCE`). The grant's app dimension comes from
   `x-vibevarium-on-behalf-of-app` (default `user`).
2. **App-context (pre-M2M placeholder)**: `x-vibevarium-app` +
   `x-vibevarium-app-secret` headers against `APP_SECRETS` (JSON) or
   `APP_SECRET_<NAME>` env vars. **This is not the final app credential** —
   real app M2M creds (OIDC client credentials with per-app audiences) arrive
   with Logto; the seam is the `resolveCaller` function in
   `src/integrations/routes.ts`.

## Secrets: env vars now, SecretsProvider seam for later

`src/integrations/secrets.ts` defines a one-method `SecretsProvider` service
(`resolve(reference) => Option<string>`); `SecretsProvider.envLayer` is v1 and
reads `process.env`. Per docs/providers.md, AWS Secrets Manager / Infisical /
1Password are drop-in layer replacements — the proxy code never touches env
directly. The `tokenConfigured` flag on `GET /integrations` shows whether the
referenced env var is set, without exposing the value.

## Deliberately minimal (v1 boundaries)

- Bodies are buffered, not streamed; redirects are not followed (`manual`).
- No method/path allowlists per integration — any path under `baseUrl` is
  forwarded. That's a per-integration policy addition.
- No OAuth/refresh lifecycle — tokens are static env values. The OAuth
  machinery for user connections lives in `@vibevarium/connections` and is a
  separate (compatible) spike; merging the two is a later integration.
- Audit is a table, not a tamper-evident log.
