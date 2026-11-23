import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Boot-time secret resolution for the control plane's own runtime config
 * (distinct from the SecretsProvider service, which resolves integration
 * tokens at proxy time).
 *
 * When `SECRETS_PROVIDER=aws`, the keys in {@link AWS_BOOT_SECRETS} are fetched
 * from Secrets Manager under `SECRETS_PREFIX` (default `/terrarium/prod/`) and
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
 * LOGTO_* app credentials are consumed by the CLI/auth flows, not this process.
 */
const AWS_BOOT_SECRETS = {
  "github-app-id": "GITHUB_APP_ID",
  "github-app-private-key": "GITHUB_APP_PRIVATE_KEY",
  "cloudflare-api-token": "CLOUDFLARE_API_TOKEN",
  // Logto app credentials — reserved for control-plane-side Logto management
  // calls; harmless when unset consumers ignore them.
  "logto-m2m-app-id": "LOGTO_M2M_APP_ID",
  "logto-m2m-app-secret": "LOGTO_M2M_APP_SECRET",
  "logto-gui-app-id": "LOGTO_GUI_APP_ID",
  "logto-gui-app-secret": "LOGTO_GUI_APP_SECRET",
  "logto-cli-app-id": "LOGTO_CLI_APP_ID",
  "logto-mcp-resource": "LOGTO_MCP_RESOURCE",
  "discovery-client-id": "DISCOVERY_CLIENT_ID",
  "discovery-client-secret": "DISCOVERY_CLIENT_SECRET",
  // Connections (docs/connections.md): the GitHub OAuth client for the
  // meta-OAuth provider + the AES-256-GCM key for tokens at rest.
  "github-oauth-client-id": "GITHUB_OAUTH_CLIENT_ID",
  "github-oauth-client-secret": "GITHUB_OAUTH_CLIENT_SECRET",
  "connections-token-encryption-key": "CONNECTIONS_TOKEN_ENCRYPTION_KEY",
  // Control-plane database (DB-SPIKE.md): the full postgres:// URL for RDS.
  // When unset the box falls back to embedded PGlite via DATABASE_PATH.
  "database-url": "DATABASE_URL",
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

  const prefix = process.env.SECRETS_PREFIX ?? "/terrarium/prod/";
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
