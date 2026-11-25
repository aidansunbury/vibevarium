import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const hasAwsCredentials = () =>
  process.env.AWS_ACCESS_KEY_ID !== undefined ||
  process.env.AWS_PROFILE !== undefined ||
  process.env.AWS_ROLE_ARN !== undefined ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined ||
  process.env.AWS_EC2_METADATA_DISABLED !== "true";

/** A secret's name + provenance — used by the separate per-app secret store. */
export interface SecretMeta {
  readonly name: string;
  readonly description?: string | undefined;
  readonly lastChangedDate?: string | undefined;
}

/**
 * Read-only platform secret resolution. The running control plane cannot list,
 * create, overwrite, or delete platform Secrets Manager entries through any API.
 * Only statically configured references are resolved for OAuth, proxy, and
 * webhook credentials.
 */
export class SecretsProvider extends Context.Service<SecretsProvider, {
  readonly resolve: (reference: string) => Effect.Effect<Option.Option<string>>;
}>()("@vibevarium/control-plane/integrations/SecretsProvider") {
  static readonly envLayer = Layer.succeed(SecretsProvider, SecretsProvider.of({
    resolve: (reference) => Effect.sync(() => Option.fromUndefinedOr(process.env[reference])),
  }));

  static readonly awsLayer = (options: {
    readonly prefix: string;
    readonly region?: string | undefined;
    readonly cacheTtlMs?: number | undefined;
  }): Layer.Layer<SecretsProvider> => {
    const ttl = options.cacheTtlMs ?? 60_000;
    if (!hasAwsCredentials()) {
      console.warn("[secrets] SECRETS_PROVIDER=aws but no AWS credentials discoverable — falling back to env");
      return SecretsProvider.envLayer;
    }

    return Layer.sync(SecretsProvider, () => {
      const client = new SecretsManagerClient(options.region === undefined ? {} : { region: options.region });
      const cache = new Map<string, { readonly value: string; readonly expiresAt: number }>();

      const fetch = (name: string): Effect.Effect<Option.Option<string>> =>
        Effect.promise(async () => {
          try {
            const response = await client.send(new GetSecretValueCommand({ SecretId: options.prefix + name }));
            return Option.fromUndefinedOr(response.SecretString);
          } catch {
            return Option.none<string>();
          }
        });

      return SecretsProvider.of({
        resolve: (reference) =>
          Effect.suspend(() => {
            const fromEnv = process.env[reference];
            if (fromEnv !== undefined) return Effect.succeed(Option.some(fromEnv));
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

  static readonly layerFromEnv = (): Layer.Layer<SecretsProvider> => {
    if (process.env.SECRETS_PROVIDER === "aws") {
      return SecretsProvider.awsLayer({
        prefix: process.env.SECRETS_PREFIX ?? "/vibevarium/prod/",
        region: process.env.AWS_REGION,
      });
    }
    return SecretsProvider.envLayer;
  };
}
