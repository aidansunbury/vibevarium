import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));
const SecretRef = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_/-]+$/));
const HttpUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/.+/));
/** Remote image URL or a local asset path served by the GUI (for example /provider-logos/github.svg). */
const LogoUrl = Schema.String.check(Schema.isNonEmpty());

const SecretDefinitionSchema = Schema.Struct({
  /** Name in the external secret store (env var locally, Secrets Manager name in prod). */
  ref: SecretRef,
});

const OAuthProviderSchema = Schema.Struct({
  displayName: Schema.String.check(Schema.isNonEmpty()),
  logoUrl: Schema.optional(LogoUrl),
  authorizeUrl: HttpUrl,
  tokenUrl: HttpUrl,
  userinfoUrl: HttpUrl,
  apiBaseUrl: HttpUrl,
  clientIdRef: SecretRef,
  /** Key in `secrets` holding the OAuth client secret. */
  clientSecret: Slug,
  defaultScopes: Schema.Array(Schema.String),
  responseMode: Schema.optional(Schema.Literals(["query", "form_post"])),
  scopeSeparator: Schema.optional(Schema.String),
  authorizeParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** `userinfo` handles OIDC and GitHub-shaped REST responses; Linear uses GraphQL. */
  identity: Schema.optional(Schema.Literals(["userinfo", "linear"])),
});

const ProxiedSecretSchema = Schema.Struct({
  displayName: Schema.String.check(Schema.isNonEmpty()),
  logoUrl: Schema.optional(LogoUrl),
  baseUrl: HttpUrl,
  /** Key in `secrets` holding the token attached to proxied requests. */
  secret: Slug,
  authHeader: Schema.optional(Schema.Literals(["authorization_bearer", "authorization", "x-api-key", "none"])),
  timeoutMs: Schema.optional(Schema.Number),
});

const WebhookSourceSchema = Schema.Struct({
  displayName: Schema.String.check(Schema.isNonEmpty()),
  logoUrl: Schema.optional(LogoUrl),
  /** Key in `secrets` holding the ingress verification secret. */
  secret: Slug,
  verification: Schema.optional(Schema.Literals(["hmac-sha256", "bearer", "none"])),
  eventTypeHeader: Schema.optional(Schema.String),
});

export const ConnectionsConfigSchema = Schema.Struct({
  /** Key in `secrets` used to encrypt OAuth access/refresh tokens at rest. */
  oauthTokenEncryption: Schema.optional(Slug),
  /** Named references only. Secret values NEVER belong in this file. */
  secrets: Schema.Record(Slug, SecretDefinitionSchema),
  oauthProviders: Schema.Record(Slug, OAuthProviderSchema),
  proxiedSecrets: Schema.Record(Slug, ProxiedSecretSchema),
  webhooks: Schema.Record(Slug, WebhookSourceSchema),
  /** App slug → key in `secrets` used to sign webhook deliveries to that app. */
  webhookDeliverySecrets: Schema.Record(Slug, Slug),
});

export type ConnectionsConfig = typeof ConnectionsConfigSchema.Type;
export type OAuthProviderConfig = typeof OAuthProviderSchema.Type;
export type ProxiedSecretConfig = typeof ProxiedSecretSchema.Type;
export type WebhookSourceConfig = typeof WebhookSourceSchema.Type;

/** Decode and cross-check all slug references at startup. */
export const validateConnectionsConfig = (input: unknown): ConnectionsConfig => {
  const config = Schema.decodeUnknownSync(ConnectionsConfigSchema)(input);
  const assertHttpUrl = (owner: string, value: string) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new Error(`Invalid connections config: ${owner} must be a valid absolute http(s) URL`);
    }
  };
  const requireSecret = (owner: string, slug: string) => {
    if (secretRef(config, slug) === undefined) {
      throw new Error(`Invalid connections config: ${owner} references unknown secret slug "${slug}"`);
    }
  };

  const oauthEntries = Object.entries(config.oauthProviders);
  if (oauthEntries.length > 0 && config.oauthTokenEncryption === undefined) {
    throw new Error("Invalid connections config: oauthTokenEncryption is required when OAuth providers are configured");
  }
  if (config.oauthTokenEncryption !== undefined) {
    requireSecret("oauthTokenEncryption", config.oauthTokenEncryption);
  }

  for (const [slug, provider] of oauthEntries) {
    assertHttpUrl(`oauthProviders.${slug}.authorizeUrl`, provider.authorizeUrl);
    assertHttpUrl(`oauthProviders.${slug}.tokenUrl`, provider.tokenUrl);
    assertHttpUrl(`oauthProviders.${slug}.userinfoUrl`, provider.userinfoUrl);
    assertHttpUrl(`oauthProviders.${slug}.apiBaseUrl`, provider.apiBaseUrl);
    requireSecret(`oauthProviders.${slug}.clientSecret`, provider.clientSecret);
    if (Object.hasOwn(config.proxiedSecrets, slug)) {
      throw new Error(`Invalid connections config: "${slug}" cannot be both an OAuth provider and a proxied secret`);
    }
  }
  for (const [slug, integration] of Object.entries(config.proxiedSecrets)) {
    assertHttpUrl(`proxiedSecrets.${slug}.baseUrl`, integration.baseUrl);
    requireSecret(`proxiedSecrets.${slug}.secret`, integration.secret);
    if (integration.timeoutMs !== undefined && (!Number.isInteger(integration.timeoutMs) || integration.timeoutMs <= 0)) {
      throw new Error(`Invalid connections config: proxiedSecrets.${slug}.timeoutMs must be a positive integer`);
    }
  }
  for (const [slug, source] of Object.entries(config.webhooks)) {
    requireSecret(`webhooks.${slug}.secret`, source.secret);
  }
  for (const [app, secret] of Object.entries(config.webhookDeliverySecrets)) {
    requireSecret(`webhookDeliverySecrets.${app}`, secret);
  }
  return config;
};

export const secretRef = (config: ConnectionsConfig, slug: string): string | undefined =>
  Object.hasOwn(config.secrets, slug) ? config.secrets[slug]?.ref : undefined;

export const webhookDeliverySecretRef = (config: ConnectionsConfig, app: string): string | undefined => {
  const slug = Object.hasOwn(config.webhookDeliverySecrets, app) ? config.webhookDeliverySecrets[app] : undefined;
  return slug === undefined ? undefined : secretRef(config, slug);
};

export class ConnectionsConfigService extends Context.Service<ConnectionsConfigService, {
  readonly config: ConnectionsConfig;
  readonly secretRef: (slug: string) => string | undefined;
  readonly webhookDeliverySecretRef: (app: string) => string | undefined;
}>()("@vibevarium/control-plane/ConnectionsConfigService") {
  static readonly layer = (input: unknown) =>
    Layer.sync(ConnectionsConfigService, () => {
      const config = validateConnectionsConfig(input);
      return ConnectionsConfigService.of({
        config,
        secretRef: (slug) => secretRef(config, slug),
        webhookDeliverySecretRef: (app) => webhookDeliverySecretRef(config, app),
      });
    });
}
