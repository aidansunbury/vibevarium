import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * SecretsProvider seam (see docs/providers.md): integrations never store token
 * values in the database — only a reference (the env var name). v1 resolves
 * references from process env; AWS Secrets Manager / Infisical / 1Password are
 * drop-in replacements for this one service.
 */
export class SecretsProvider extends Context.Service<SecretsProvider, {
  readonly resolve: (reference: string) => Effect.Effect<Option.Option<string>>;
}>()("@terrarium/control-plane/integrations/SecretsProvider") {
  static readonly envLayer = Layer.succeed(SecretsProvider, SecretsProvider.of({
    resolve: (reference) => Effect.sync(() => Option.fromUndefinedOr(process.env[reference])),
  }));

  /**
   * AWS Secrets Manager provider. References are secret names relative to
   * `prefix` (e.g. `cloudflare-api-token` → `/terrarium/prod/cloudflare-api-token`).
   *
   * - Values are cached in memory with a TTL (default 60s) so proxy-time
   *   resolutions don't hammer SM; a miss refreshes the entry.
   * - When no AWS credentials are discoverable (local dev without SSO), the
   *   layer falls back to env resolution — `SECRETS_PROVIDER=aws` on a
   *   credential-less machine degrades to envLayer behavior.
   * - Secrets that don't exist (or aren't permitted) resolve to Option.none.
   *
   * See SECRETS-SPIKE.md for the design.
   */
  static readonly awsLayer = (options: {
    readonly prefix: string;
    readonly region?: string | undefined;
    readonly cacheTtlMs?: number | undefined;
  }): Layer.Layer<SecretsProvider> => {
    const ttl = options.cacheTtlMs ?? 60_000;
    const hasCredentials = () =>
      process.env.AWS_ACCESS_KEY_ID !== undefined ||
      process.env.AWS_PROFILE !== undefined ||
      process.env.AWS_ROLE_ARN !== undefined ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined ||
      process.env.AWS_EC2_METADATA_DISABLED !== "true"; // IMDS default chain (EC2 instance profile)

    if (!hasCredentials()) {
      console.warn("[secrets] SECRETS_PROVIDER=aws but no AWS credentials discoverable — falling back to env");
      return SecretsProvider.envLayer;
    }

    return Layer.sync(SecretsProvider, () => {
      const client = new SecretsManagerClient(
        options.region === undefined ? {} : { region: options.region },
      );
      const cache = new Map<string, { readonly value: string; readonly expiresAt: number }>();

      const fetch = (name: string) =>
        Effect.tryPromise({
          try: async () => {
            const response = await client.send(
              new GetSecretValueCommand({ SecretId: options.prefix + name }),
            );
            return response.SecretString;
          },
          // ResourceNotFoundException / AccessDeniedException / DecryptionFailure
          // all degrade to "no secret" — the caller surfaces 502 secret_unavailable.
          catch: () => undefined,
        }).pipe(Effect.map(Option.fromUndefinedOr));

      return SecretsProvider.of({
        resolve: (reference) =>
          Effect.suspend(() => {
            const cached = cache.get(reference);
            if (cached !== undefined && cached.expiresAt > Date.now()) {
              return Effect.succeed(Option.some(cached.value));
            }
            return fetch(reference).pipe(Effect.map((result) => {
              if (Option.isSome(result)) {
                cache.set(reference, { value: result.value, expiresAt: Date.now() + ttl });
              }
              return result;
            }));
          }),
      });
    });
  };

  /**
   * Selects the provider from env: `SECRETS_PROVIDER=aws|env` (default env).
   * AWS shape: `SECRETS_PREFIX` (default `/terrarium/prod/`), `AWS_REGION`.
   */
  static readonly layerFromEnv = (): Layer.Layer<SecretsProvider> => {
    if (process.env.SECRETS_PROVIDER === "aws") {
      return SecretsProvider.awsLayer({
        prefix: process.env.SECRETS_PREFIX ?? "/terrarium/prod/",
        region: process.env.AWS_REGION,
      });
    }
    return SecretsProvider.envLayer;
  };
}
