import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Boot-time secret resolution for the control plane's own runtime config
 * (distinct from the SecretsProvider service, which resolves integration
 * tokens at proxy time).
 *
 * When `SECRETS_PROVIDER=aws`, the keys in {@link AWS_BOOT_SECRETS} are fetched
 * from Secrets Manager under `SECRETS_PREFIX` (default `/vibevarium/prod/`) and
 * set into `process.env` before `src/main.ts` reads its config — so every
 * existing `process.env.X` consumer (main.ts, router-directory.ts, …) works
 * unchanged in both modes. With any other value (default `env`) this is a
 * no-op and the process relies on real environment variables.
 *
 * See SECRETS-SPIKE.md for the boot order and rationale.
 */

/**
 * Secrets Manager name (relative to the prefix) → env var populated at boot.
 * Only keys the control-plane runtime actually consumes are mapped.
 */
export const AWS_BOOT_SECRETS = {
  // Secret names intentionally match the runtime environment variables they
  // populate. This object is the source-aware secret configuration: the key is
  // the AWS Secrets Manager name relative to SECRETS_PREFIX, the value is the
  // process.env destination.
  GITHUB_APP_ID: "GITHUB_APP_ID",
  GITHUB_APP_PRIVATE_KEY: "GITHUB_APP_PRIVATE_KEY",
  CLOUDFLARE_API_TOKEN: "CLOUDFLARE_API_TOKEN",
  // Casdoor GUI OIDC credentials. Provisioner credentials resolve at scaffold time.
  GUI_APP_ID: "GUI_APP_ID",
  GUI_APP_SECRET: "GUI_APP_SECRET",
  // Durable GUI sessions: AES-256-GCM encryption + separated cookie/HMAC keys.
  SESSION_ENCRYPTION_KEY: "SESSION_ENCRYPTION_KEY",
  // WorkOS AuthKit (TERRARIUM_AUTH_PROVIDER=workos): the public OAuth client +
  // server-side API key for user/org reads and DCR administration.
  WORKOS_CLIENT_ID: "WORKOS_CLIENT_ID",
  WORKOS_API_KEY: "WORKOS_API_KEY",
  DISCOVERY_CLIENT_ID: "DISCOVERY_CLIENT_ID",
  DISCOVERY_CLIENT_SECRET: "DISCOVERY_CLIENT_SECRET",
  // Connections: OAuth clients + the AES-256-GCM key for provider tokens.
  GITHUB_OAUTH_CLIENT_ID: "GITHUB_OAUTH_CLIENT_ID",
  GITHUB_OAUTH_CLIENT_SECRET: "GITHUB_OAUTH_CLIENT_SECRET",
  LINEAR_OAUTH_CLIENT_ID: "LINEAR_OAUTH_CLIENT_ID",
  LINEAR_OAUTH_CLIENT_SECRET: "LINEAR_OAUTH_CLIENT_SECRET",
  CONNECTIONS_TOKEN_ENCRYPTION_KEY: "CONNECTIONS_TOKEN_ENCRYPTION_KEY",
  // Control-plane database (DB-SPIKE.md): the full postgres:// URL for RDS.
  // When unset the box falls back to embedded PGlite via DATABASE_PATH.
  DATABASE_URL: "DATABASE_URL",
} as const;

const hasAwsCredentials = () =>
  process.env.AWS_ACCESS_KEY_ID !== undefined ||
  process.env.AWS_PROFILE !== undefined ||
  process.env.AWS_ROLE_ARN !== undefined ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined ||
  process.env.AWS_EC2_METADATA_DISABLED !== "true";

export interface BootSecretsReport {
  readonly provider: "aws" | "env";
  readonly prefix?: string;
  /** Env var names resolved from the secret store. Never values. */
  readonly resolved: Array<string>;
  /** Env var names whose secret fetch failed. Never values. */
  readonly failed: Array<string>;
}

/** Resolved-config provenance for the /config-check endpoint (names only). */
export const bootSecretsReport: BootSecretsReport = {
  provider: process.env.SECRETS_PROVIDER === "aws" ? "aws" : "env",
  resolved: [],
  failed: [],
};

/**
 * When SECRETS_PROVIDER=aws, fetch every boot secret and inject into env.
 * Real env vars always win (never overwritten) so local overrides keep working.
 */
export const loadBootSecrets = async (): Promise<void> => {
  if (process.env.SECRETS_PROVIDER !== "aws") return;

  const prefix = process.env.SECRETS_PREFIX ?? "/vibevarium/prod/";
  (bootSecretsReport as { prefix?: string }).prefix = prefix;

  if (!hasAwsCredentials()) {
    console.warn("[secrets] SECRETS_PROVIDER=aws but no AWS credentials discoverable — boot config comes from env");
    return;
  }

  const client = new SecretsManagerClient(
    process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION },
  );

  await Promise.all(
    Object.entries(AWS_BOOT_SECRETS).map(async ([secretName, envName]) => {
      if (process.env[envName] !== undefined) return; // real env wins
      try {
        const response = await client.send(
          new GetSecretValueCommand({ SecretId: prefix + secretName }),
        );
        if (response.SecretString !== undefined) {
          process.env[envName] = response.SecretString;
          bootSecretsReport.resolved.push(envName);
        } else {
          bootSecretsReport.failed.push(envName);
        }
      } catch {
        bootSecretsReport.failed.push(envName);
      }
    }),
  );
};
