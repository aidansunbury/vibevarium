import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

// Static env keys + the IMDS default chain (EC2 instance profile). When none
// are present the AWS provider degrades to env resolution — local dev without
// SSO never hard-fails on SECRETS_PROVIDER=aws.
const hasAwsCredentials = () =>
  process.env.AWS_ACCESS_KEY_ID !== undefined ||
  process.env.AWS_PROFILE !== undefined ||
  process.env.AWS_ROLE_ARN !== undefined ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined ||
  process.env.AWS_EC2_METADATA_DISABLED !== "true";

/**
 * SecretsProvider seam (see docs/providers.md): integrations never store token
 * values in the database — only a reference (the env var name). v1 resolves
 * references from process env; AWS Secrets Manager / Infisical / 1Password are
 * drop-in replacements for this one service.
 */
/** A secret's name + provenance, never its value (the set-only trust model). */
export interface SecretMeta {
  readonly name: string;
  readonly description?: string | undefined;
  readonly lastChangedDate?: string | undefined;
}

/** Thrown when a write is attempted against a read-only provider (env/local). */
export class SecretsWriteUnsupportedError extends Error {
  readonly _tag = "SecretsWriteUnsupportedError";
  constructor() {
    super("This secrets provider is read-only (env mode) — writes need SECRETS_PROVIDER=aws");
  }
}

export class SecretsProvider extends Context.Service<SecretsProvider, {
  readonly resolve: (reference: string) => Effect.Effect<Option.Option<string>>;
  /**
   * List secret names + metadata under the provider's prefix. Never values.
   * Throws SecretsWriteUnsupportedError in env mode (no listable store).
   */
  readonly list: () => Effect.Effect<ReadonlyArray<SecretMeta>, SecretsWriteUnsupportedError>;
  /**
   * Create or overwrite a secret value. Set-only: the provider never reads it
   * back through this interface. Throws SecretsWriteUnsupportedError in env mode.
   */
  readonly put: (reference: string, value: string) => Effect.Effect<void, SecretsWriteUnsupportedError>;
  /**
   * Delete a secret (force, no recovery window on AWS). Used for app-secret
   * teardown. Throws SecretsWriteUnsupportedError in env mode.
   */
  readonly remove: (reference: string) => Effect.Effect<void, SecretsWriteUnsupportedError>;
}>()("@vibevarium/control-plane/integrations/SecretsProvider") {
  static readonly envLayer = Layer.succeed(SecretsProvider, SecretsProvider.of({
    resolve: (reference) => Effect.sync(() => Option.fromUndefinedOr(process.env[reference])),
    list: () => Effect.fail(new SecretsWriteUnsupportedError()),
    put: () => Effect.fail(new SecretsWriteUnsupportedError()),
    remove: () => Effect.fail(new SecretsWriteUnsupportedError()),
  }));

  /**
   * AWS Secrets Manager provider. References are secret names relative to
   * `prefix` (e.g. `cloudflare-api-token` → `/vibevarium/prod/cloudflare-api-token`).
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
    if (!hasAwsCredentials()) {
      console.warn("[secrets] SECRETS_PROVIDER=aws but no AWS credentials discoverable — falling back to env");
      return SecretsProvider.envLayer;
    }

    return Layer.sync(SecretsProvider, () => {
      const client = new SecretsManagerClient(
        options.region === undefined ? {} : { region: options.region },
      );
      const cache = new Map<string, { readonly value: string; readonly expiresAt: number }>();

      const fetch = (name: string): Effect.Effect<Option.Option<string>> =>
        Effect.promise(async () => {
          try {
            const response = await client.send(
              new GetSecretValueCommand({ SecretId: options.prefix + name }),
            );
            return Option.fromUndefinedOr(response.SecretString);
          } catch {
            // ResourceNotFoundException / AccessDeniedException / DecryptionFailure
            // all degrade to "no secret" — the caller surfaces 502 secret_unavailable.
            return Option.none<string>();
          }
        });

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
        list: () =>
          Effect.promise(async () => {
            // ListSecrets pages through names + metadata under the prefix. The
            // response carries names/descriptions/last-changed — never values.
            const out: Array<SecretMeta> = [];
            let nextToken: string | undefined;
            do {
              const page: import("@aws-sdk/client-secrets-manager").ListSecretsCommandOutput = await client.send(
                new ListSecretsCommand({
                  ...(nextToken === undefined ? {} : { NextToken: nextToken }),
                  Filters: [{ Key: "name", Values: [options.prefix] }],
                }),
              );
              for (const entry of page.SecretList ?? []) {
                if (entry.Name === undefined) continue;
                out.push({
                  name: entry.Name.slice(options.prefix.length),
                  ...(entry.Description === undefined ? {} : { description: entry.Description }),
                  ...(entry.LastChangedDate === undefined
                    ? {}
                    : { lastChangedDate: entry.LastChangedDate.toISOString() }),
                });
              }
              nextToken = page.NextToken;
            } while (nextToken !== undefined);
            return out;
          }),
        put: (reference, value) =>
          Effect.promise(async () => {
            const name = options.prefix + reference;
            try {
              // Prefer updating an existing secret (PutSecretValue adds a new
              // version). If it doesn't exist, create it.
              await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
            } catch (error) {
              const code = (error as { name?: string }).name;
              if (code === "ResourceNotFoundException") {
                await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
              } else {
                throw error;
              }
            }
            // Invalidate the read cache so a following resolve sees the new value.
            cache.delete(reference);
          }),
        remove: (reference) =>
          Effect.promise(async () => {
            await client.send(
              new DeleteSecretCommand({ SecretId: options.prefix + reference, ForceDeleteWithoutRecovery: true }),
            );
            cache.delete(reference);
          }),
      });
    });
  };

  /**
   * Selects the provider from env: `SECRETS_PROVIDER=aws|env` (default env).
   * AWS shape: `SECRETS_PREFIX` (default `/vibevarium/prod/`), `AWS_REGION`.
   */
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
