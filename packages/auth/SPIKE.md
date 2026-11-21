# OIDC auth spike

## What worked

The standard OIDC boundary is enough for local development and verification:

- `@terrarium/dev-issuer` generates an RSA key pair at boot and serves OIDC
  discovery plus a public JWKS. It mints RS256 access tokens and ID tokens with
  `iss`, `sub`, `aud`, `iat`, `exp`, and optional `name` claims.
- The non-standard `GET /dev/token` endpoint is a development shortcut for a
  fake user. A minimal standard authorization-code + S256 PKCE flow is also
  available at `/authorize` and `/token`; codes expire after five minutes and
  are single-use.
- `@terrarium/auth` fetches and validates discovery at layer construction,
  verifies that its issuer matches the configured issuer, resolves `jwks_uri`,
  and delegates signature and claim verification to `jose`.
- `requireAuth` accepts only `Authorization: Bearer ...`, turns every verification
  failure into a 401, and provides the verified `CurrentActor` to the wrapped
  Effect route.
- The tests exercise real HTTP servers, including a protected Effect
  `HttpRouter` route. Tampering, wrong audiences, and expiration have distinct
  typed errors.

No vendor SDK or provider-specific API is involved.

## Run it

From the repository root:

```sh
pnpm vitest run packages/auth packages/dev-issuer
pnpm exec tsrs --noEmit -p packages/auth/tsconfig.json
pnpm exec tsrs --noEmit -p packages/dev-issuer/tsconfig.json
```

Run a standalone issuer on port 4010:

```sh
pnpm --filter @terrarium/dev-issuer start
```

Optional environment variables are `PORT`, `OIDC_ISSUER`, and the comma-separated
`OIDC_AUDIENCES` (default `my-app`). With the standalone server running:

```sh
curl 'http://127.0.0.1:4010/dev/token?sub=user-1&name=Ada&aud=my-app'
```

The programmatic API defaults to an ephemeral port:

```ts
const devIssuer = await startDevIssuer({ audiences: ["my-app"] })
// devIssuer.issuer is the discovered bound URL.
await devIssuer.close()
```

`DevAuth.fetchToken` is the Effect-based test/demo helper for the same endpoint.

## Swapping in Logto or WorkOS

Application configuration remains just the issuer and API audience:

```ts
const authLayer = Auth.layer({
  issuer: "https://auth.example.com/",
  audience: "https://api.example.com/my-app"
})
```

The issuer must publish a compliant discovery document whose `issuer` matches
that configuration (trailing slashes are normalized), a reachable `jwks_uri`,
and JWTs signed by those keys. Register `https://api.example.com/my-app` as the
API resource/audience in the provider. No middleware or handler changes are
needed when moving between providers.

One provider-side detail matters: some OIDC servers issue opaque access tokens
until an API resource is configured. This verifier intentionally accepts JWTs,
not opaque tokens or vendor introspection APIs. Also, `sub` is always available,
but `name` is optional and a provider may include it only in ID tokens or after a
profile claim is enabled.

JWKS keys are cached by `jose` (ten-minute default maximum age, 30-second default
refresh cooldown). An unknown key can trigger a refresh, and `Auth.refreshJwks()`
forces one. Both timings are configurable on `Auth.layer`.

## Local-only limitations and awkward bits

- The dev issuer is deliberately not a production identity provider: keys are
  ephemeral, every restart invalidates existing tokens, and there is no user
  database, consent screen, client registry, or persistent authorization state.
  Its PKCE endpoint automatically logs in the requested fake user and treats
  configured audiences as public client IDs.
- `expires_in` on `/dev/token` is a test hook; a negative value creates an
  expired token. Do not expose this issuer outside local development.
- Effect 4's HTTP modules export both a service named `HttpRouter` and namespace
  functions. Route construction should use `import * as HttpRouter from
  "effect/http/HttpRouter"`; importing only the named service hides `add` and
  `serve`.
- Import `@effect/platform-node/NodeHttpServer` directly. The package barrel also
  loads the Redis integration, whose peer dependency is not installed in this
  spike. `pnpm install` therefore reports a non-blocking peer warning.
- TypeScript executable entrypoints use Node's built-in type stripping
  (`node --experimental-strip-types`), so the dev issuer's `tsconfig` enables
  `.ts` import extensions and Node types. No `tsx` dependency is needed.
