/**
 * Centralized platform configuration — the single source of truth for every
 * runtime knob the control plane reads (docs/provisioning.md §2).
 *
 * Productionized config in two parts:
 *
 * 1. **Parsing** — one `Config.Config<FlatConfig>` built with Effect's `Config`
 *    module: every env var is declared once, typed, defaulted, and validated at
 *    parse time. A malformed value (bad int, an enum outside its literals) is a
 *    single loud `ConfigError` at boot — not a silent `undefined` deep in a
 *    request handler. `makePlatformConfig` then assembles the flat leaves into
 *    the optional integration *blocks* the rest of the codebase consumes.
 *
 * 2. **Capability validation** — the config declares which provisioning options
 *    are *enabled* (deploy targets, database, features, auth server);
 *    `validateCapabilities` checks each enabled option actually has the
 *    credentials it needs (via the SecretsProvider seam: env locally, AWS
 *    Secrets Manager in prod). "We support PlanetScale Hyperdrive" is a claim
 *    the platform must *prove* with resolvable credentials — enabled-but-
 *    unbacked options are surfaced with their missing refs, never silently
 *    offered. Secrets are never stored or logged — only *which* references
 *    resolved.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as ContextT from "effect/Context";
import { SecretsProvider } from "../integrations/secrets.ts";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const DeployTarget = Schema.Literals(["cloudflare", "aws"]);
export type DeployTarget = typeof DeployTarget.Type;

export const DatabaseOption = Schema.Literals(["cf-d1", "planetscale-hyperdrive"]);
export type DatabaseOption = typeof DatabaseOption.Type;

export const Feature = Schema.Literals(["r2", "hyperdrive"]);
export type Feature = typeof Feature.Type;

export const AuthProvider = Schema.Literals(["logto", "workos"]);
export type AuthProvider = typeof AuthProvider.Type;

/** Comma-separated env list decoded to trimmed non-empty strings, validated against `literals`. */
const csvLiterals = <L extends string>(literals: ReadonlyArray<L>, name: string) =>
  Config.String(name).pipe(
    Config.map((raw) => raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)),
    Config.mapEffect((parts) => {
      const invalid = parts.filter((part) => !(literals as ReadonlyArray<string>).includes(part));
      return invalid.length === 0
        ? Effect.succeed(parts as Array<L>)
        : Effect.fail(
            new Config.ConfigError({
              _tag: "InvalidData",
              path: [name],
              description: `invalid value(s): ${invalid.join(", ")} (expected ${literals.join(" | ")})`,
            } as never),
          );
    }),
  );

// ---------------------------------------------------------------------------
// The flat config leaves (every env var declared once, here)
// ---------------------------------------------------------------------------

const flatConfig = Config.all({
  port: Config.Int("PORT").pipe(Config.withDefault(4100)),
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  baseUrl: Config.String("CONTROL_PLANE_BASE_URL").pipe(Config.withDefault("")),
  domain: Config.String("TERRARIUM_DOMAIN").pipe(Config.withDefault("vibevarium.com")),
  guiDir: Config.option(Config.NonEmptyString("GUI_DIR")),

  databaseUrl: Config.option(Config.NonEmptyString("DATABASE_URL")),
  databasePath: Config.option(Config.NonEmptyString("DATABASE_PATH")),

  discoveryIntervalMs: Config.Int("DISCOVERY_INTERVAL_MS").pipe(Config.withDefault(30_000)),
  discoveryTimeoutMs: Config.Int("DISCOVERY_TIMEOUT_MS").pipe(Config.withDefault(3_000)),
  callTimeoutMs: Config.Int("CALL_TIMEOUT_MS").pipe(Config.withDefault(3_000)),
  discoveryToken: Config.option(Config.NonEmptyString("DISCOVERY_TOKEN")),

  deployTargets: csvLiterals(["cloudflare", "aws"], "TERRARIUM_DEPLOY_TARGETS").pipe(
    Config.withDefault(["cloudflare"] as Array<DeployTarget>),
  ),
  database: Config.schema(DatabaseOption, "TERRARIUM_DATABASE").pipe(
    Config.withDefault("cf-d1" as DatabaseOption),
  ),
  features: csvLiterals(["r2", "hyperdrive"], "TERRARIUM_FEATURES").pipe(
    Config.withDefault([] as Array<Feature>),
  ),
  authProvider: Config.schema(AuthProvider, "TERRARIUM_AUTH_PROVIDER").pipe(
    Config.withDefault("logto" as AuthProvider),
  ),

  startupTimeoutMs: Config.Int("APP_START_TIMEOUT_MS").pipe(Config.withDefault(20_000)),
  appsRoot: Config.option(Config.NonEmptyString("TERRARIUM_APPS_ROOT")),
  issuer: Config.option(Config.NonEmptyString("TERRARIUM_ISSUER")),
  connectionsRefreshSkewMs: Config.option(Config.Int("CONNECTIONS_REFRESH_SKEW_MS")),

  // Block marker keys (presence turns a whole optional block on).
  logtoIssuer: Config.String("LOGTO_ISSUER").pipe(Config.withDefault("")),
  platformAudience: Config.option(Config.NonEmptyString("PLATFORM_OIDC_AUDIENCE")),
  controlPlaneIssuer: Config.option(Config.NonEmptyString("CONTROL_PLANE_ISSUER")),
  controlPlaneAudience: Config.option(Config.NonEmptyString("CONTROL_PLANE_AUDIENCE")),
  guiAppId: Config.option(Config.NonEmptyString("LOGTO_GUI_APP_ID")),
  guiAppSecret: Config.option(Config.NonEmptyString("LOGTO_GUI_APP_SECRET")),
  discoveryClientId: Config.option(Config.NonEmptyString("DISCOVERY_CLIENT_ID")),
  discoveryClientSecret: Config.option(Config.NonEmptyString("DISCOVERY_CLIENT_SECRET")),
  discoveryScope: Config.String("DISCOVERY_SCOPE").pipe(Config.withDefault("member")),

  cloudflareAccountId: Config.option(Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID")),
  cloudflareZoneId: Config.option(Config.NonEmptyString("CLOUDFLARE_ZONE_ID")),
  cloudflareWorkersSubdomain: Config.option(Config.NonEmptyString("CLOUDFLARE_WORKERS_SUBDOMAIN")),
  routerKvNamespaceId: Config.option(Config.NonEmptyString("ROUTER_KV_NAMESPACE_ID")),
  alchemyHome: Config.option(Config.NonEmptyString("ALCHEMY_HOME")),
  awsRegion: Config.String("AWS_REGION").pipe(Config.withDefault("us-east-1")),

  planetscaleHost: Config.option(Config.NonEmptyString("PLANETSCALE_HOST")),
  planetscaleUsername: Config.option(Config.NonEmptyString("PLANETSCALE_USERNAME")),
  planetscalePassword: Config.option(Config.NonEmptyString("PLANETSCALE_PASSWORD")),
  planetscaleDatabase: Config.option(Config.NonEmptyString("PLANETSCALE_DATABASE")),
  cloudflareHyperdriveId: Config.option(Config.NonEmptyString("CLOUDFLARE_HYPERDRIVE_ID")),

  gitProvider: Config.String("GIT_PROVIDER").pipe(Config.withDefault("local")),
  githubAppId: Config.option(Config.NonEmptyString("GITHUB_APP_ID")),
  githubAppPrivateKeyPath: Config.option(Config.NonEmptyString("GITHUB_APP_PRIVATE_KEY_PATH")),
  githubAppPrivateKey: Config.option(Config.NonEmptyString("GITHUB_APP_PRIVATE_KEY")),
  githubAppInstallationId: Config.option(Config.Int("GITHUB_APP_INSTALLATION_ID")),
  githubOrg: Config.String("GITHUB_ORG").pipe(Config.withDefault("terrarium-sandbox")),

  logtoM2mAppId: Config.option(Config.NonEmptyString("LOGTO_M2M_APP_ID")),
  logtoM2mAppSecret: Config.option(Config.NonEmptyString("LOGTO_M2M_APP_SECRET")),
  logtoManagementResource: Config.String("LOGTO_MANAGEMENT_RESOURCE").pipe(
    Config.withDefault("https://default.logto.app/api"),
  ),

  workosClientId: Config.option(Config.NonEmptyString("WORKOS_CLIENT_ID")),
  workosApiKey: Config.option(Config.NonEmptyString("WORKOS_API_KEY")),
  workosIssuer: Config.String("WORKOS_ISSUER").pipe(Config.withDefault("https://api.workos.com")),
});

export type FlatConfig = typeof flatConfig extends Config.Config<infer A> ? A : never;

// ---------------------------------------------------------------------------
// The assembled platform config (optional blocks built from the leaves)
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
  readonly domain: string;
  readonly guiDir: string | undefined;

  readonly databaseUrl: string | undefined;
  readonly databasePath: string | undefined;

  readonly discoveryIntervalMs: number;
  readonly discoveryTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly discoveryToken: string | undefined;
  readonly discoveryM2M:
    | {
        readonly issuer: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly resource: string;
        readonly scope: string;
      }
    | undefined;

  readonly oidc: { readonly issuer: string; readonly audience: string } | undefined;
  readonly guiAuth:
    | {
        readonly issuer: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly baseUrl: string;
        readonly resource: string;
      }
    | undefined;

  readonly deployTargets: ReadonlyArray<DeployTarget>;
  readonly defaultDeployTarget: DeployTarget;
  readonly database: DatabaseOption;
  readonly features: ReadonlyArray<Feature>;
  readonly authProvider: AuthProvider;

  readonly cloudflare:
    | {
        readonly accountId: string;
        readonly alchemyHome: string;
        readonly workersSubdomain: string;
        readonly routerNamespaceId: string;
        readonly zoneId: string;
      }
    | undefined;
  readonly aws: { readonly region: string; readonly credentialsPresent: boolean } | undefined;
  readonly planetscale:
    | {
        readonly host: string;
        readonly username: string;
        readonly password: Redacted.Redacted<string>;
        readonly database: string;
        readonly hyperdriveId: string;
      }
    | undefined;

  readonly github:
    | {
        readonly appId: string;
        readonly privateKeyPath: string | undefined;
        readonly privateKey: string | undefined;
        readonly installationId: number;
        readonly org: string;
      }
    | undefined;
  readonly appsRoot: string | undefined;
  readonly startupTimeoutMs: number;

  readonly logto:
    | {
        readonly issuer: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly managementResource: string;
        readonly platformAudience: string;
      }
    | undefined;
  readonly workos:
    | {
        readonly issuer: string;
        readonly clientId: string;
        readonly apiKey: Redacted.Redacted<string>;
      }
    | undefined;

  readonly appSecrets: Readonly<Record<string, string>>;
  readonly connectionsRefreshSkewMs: number | undefined;
  readonly issuer: string | undefined;
}

const normalizeIssuer = (issuer: string) => issuer.replace(/\/+$/, "");
const DEFAULT_ISSUER = "https://auth.vibevarium.com/oidc";

const hasAwsCredentials = () =>
  process.env.AWS_ACCESS_KEY_ID !== undefined ||
  process.env.AWS_PROFILE !== undefined ||
  process.env.AWS_ROLE_ARN !== undefined ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined ||
  process.env.AWS_EC2_METADATA_DISABLED !== "true";

/** APP_SECRETS JSON object, or APP_SECRET_<NAME> env vars (legacy). */
const parseAppSecrets = (): Record<string, string> => {
  const fromJson = process.env.APP_SECRETS;
  if (fromJson !== undefined) {
    try {
      return JSON.parse(fromJson) as Record<string, string>;
    } catch {
      throw new Error("APP_SECRETS must be a JSON object mapping app names to shared secrets");
    }
  }
  const collected: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("APP_SECRET_") && value !== undefined) {
      collected[name.slice("APP_SECRET_".length).toLowerCase().replaceAll("_", "-")] = value;
    }
  }
  return collected;
};

const get = <A>(option: Option.Option<A>): A | undefined => Option.getOrUndefined(option);

/** Assemble the flat leaves into the final config with optional blocks. */
export const makePlatformConfig = (flat: FlatConfig): PlatformConfig => {
  const domain = flat.domain;
  const baseUrl = flat.baseUrl !== "" ? normalizeIssuer(flat.baseUrl) : `http://127.0.0.1:${flat.port}`;
  const issuer = normalizeIssuer(flat.logtoIssuer !== "" ? flat.logtoIssuer : DEFAULT_ISSUER);
  const platformAudience = get(flat.platformAudience) ?? `https://mcp.${domain}`;

  const guiAppSecret = get(flat.guiAppSecret);
  const guiAuth =
    guiAppSecret === undefined
      ? undefined
      : {
          issuer,
          clientId: get(flat.guiAppId) ?? "s9ne7qecvf20vktab5iwl",
          clientSecret: guiAppSecret,
          baseUrl,
          resource: platformAudience,
        };

  const controlPlaneIssuer = get(flat.controlPlaneIssuer);
  const oidc =
    controlPlaneIssuer !== undefined
      ? {
          issuer: normalizeIssuer(controlPlaneIssuer),
          audience: get(flat.controlPlaneAudience) ?? "control.terrarium.local",
        }
      : guiAuth !== undefined
        ? { issuer: guiAuth.issuer, audience: platformAudience }
        : undefined;

  const discoveryClientId = get(flat.discoveryClientId);
  const discoveryM2M =
    discoveryClientId === undefined
      ? undefined
      : {
          issuer,
          clientId: discoveryClientId,
          clientSecret: get(flat.discoveryClientSecret) ?? "",
          resource: platformAudience,
          scope: flat.discoveryScope,
        };

  const cloudflareAccountId = get(flat.cloudflareAccountId);
  const cloudflare =
    cloudflareAccountId === undefined
      ? undefined
      : {
          accountId: cloudflareAccountId,
          alchemyHome: get(flat.alchemyHome) ?? "",
          workersSubdomain: get(flat.cloudflareWorkersSubdomain) ?? "",
          routerNamespaceId: get(flat.routerKvNamespaceId) ?? "",
          zoneId: get(flat.cloudflareZoneId) ?? "",
        };

  const aws = hasAwsCredentials() ? { region: flat.awsRegion, credentialsPresent: true } : undefined;

  const planetscaleHost = get(flat.planetscaleHost);
  const planetscale =
    planetscaleHost === undefined
      ? undefined
      : {
          host: planetscaleHost,
          username: get(flat.planetscaleUsername) ?? "",
          password: Redacted.make(get(flat.planetscalePassword) ?? ""),
          database: get(flat.planetscaleDatabase) ?? "",
          hyperdriveId: get(flat.cloudflareHyperdriveId) ?? "",
        };

  const githubAppId = get(flat.githubAppId);
  const github =
    flat.gitProvider !== "github" || githubAppId === undefined
      ? undefined
      : {
          appId: githubAppId,
          privateKeyPath: get(flat.githubAppPrivateKeyPath),
          privateKey: get(flat.githubAppPrivateKey),
          installationId: get(flat.githubAppInstallationId) ?? 0,
          org: flat.githubOrg,
        };

  const logtoM2mAppId = get(flat.logtoM2mAppId);
  const logto =
    logtoM2mAppId === undefined
      ? undefined
      : {
          issuer,
          clientId: logtoM2mAppId,
          clientSecret: get(flat.logtoM2mAppSecret) ?? "",
          managementResource: flat.logtoManagementResource,
          platformAudience,
        };

  const workosClientId = get(flat.workosClientId);
  const workos =
    workosClientId === undefined
      ? undefined
      : {
          issuer: normalizeIssuer(flat.workosIssuer),
          clientId: workosClientId,
          apiKey: Redacted.make(get(flat.workosApiKey) ?? ""),
        };

  return {
    port: flat.port,
    host: flat.host,
    baseUrl,
    domain,
    guiDir: get(flat.guiDir),
    databaseUrl: get(flat.databaseUrl),
    databasePath: get(flat.databasePath),
    discoveryIntervalMs: flat.discoveryIntervalMs,
    discoveryTimeoutMs: flat.discoveryTimeoutMs,
    callTimeoutMs: flat.callTimeoutMs,
    discoveryToken: get(flat.discoveryToken),
    discoveryM2M,
    oidc,
    guiAuth,
    deployTargets: flat.deployTargets,
    defaultDeployTarget: flat.deployTargets[0] ?? "cloudflare",
    database: flat.database,
    features: flat.features,
    authProvider: flat.authProvider,
    cloudflare,
    aws,
    planetscale,
    github,
    appsRoot: get(flat.appsRoot),
    startupTimeoutMs: flat.startupTimeoutMs,
    logto,
    workos,
    appSecrets: parseAppSecrets(),
    connectionsRefreshSkewMs: get(flat.connectionsRefreshSkewMs),
    issuer: get(flat.issuer),
  };
};

// ---------------------------------------------------------------------------
// Capability validation — enabled options must have resolvable credentials.
// ---------------------------------------------------------------------------

export interface CapabilityStatus {
  readonly enabled: boolean;
  /** Every required secret reference resolved (env or Secrets Manager). */
  readonly credentialsValid: boolean;
  /** Why an enabled option can't be used (undefined when usable). */
  readonly reason?: string | undefined;
  /** Required secret/config references that are missing. Names only. */
  readonly missing: ReadonlyArray<string>;
}

export interface CapabilityReport {
  readonly deployTargets: Readonly<Record<DeployTarget, CapabilityStatus>>;
  readonly database: Readonly<Record<DatabaseOption, CapabilityStatus>>;
  readonly features: Readonly<Record<Feature, CapabilityStatus>>;
  readonly authProviders: Readonly<Record<AuthProvider, CapabilityStatus>>;
}

/** The SecretsProvider service shape — `Context.Service.Shape` extracts the
 *  service interface from a class-style service key. */
type Secrets = ContextT.Service.Shape<typeof SecretsProvider>;

/**
 * A reference is "resolvable" if EITHER the boot-injected env var is set
 * (config-check's provenance — works in both env and aws modes, since
 * loadBootSecrets injects SM values into process.env at boot) OR the
 * SecretsProvider resolves it. The SecretsProvider alone is not sufficient:
 * in aws mode it looks up SM by the reference name, but our env-style names
 * (CLOUDFLARE_API_TOKEN) are not valid SM secret names (cloudflare-api-token
 * is) — so an env var name would always miss in aws mode. Checking the env
 * first makes the validator provenance-correct in both modes.
 */
const resolveMissing = (secrets: Secrets, refs: ReadonlyArray<string>) =>
  Effect.forEach(refs, (ref) =>
    Effect.flatMap(Effect.sync(() => Option.fromUndefinedOr(process.env[ref])), (fromEnv) =>
      Option.isSome(fromEnv) ? Effect.succeed(fromEnv) : secrets.resolve(ref),
    ),
  ).pipe(
    Effect.map((results) => refs.filter((_, index) => !Option.isSome(results[index]!))),
  );

const status = (
  enabled: boolean,
  missing: ReadonlyArray<string>,
  reason?: string,
): CapabilityStatus => ({
  enabled,
  credentialsValid: missing.length === 0,
  missing,
  ...(reason !== undefined && missing.length > 0 ? { reason } : {}),
});

/**
 * Check each enabled capability against resolvable credentials. The report is
 * what `GET /provisioning/options` serves the wizard — an option is offered
 * only when `enabled && credentialsValid`.
 */
export const validateCapabilities = (
  config: PlatformConfig,
  secrets: Secrets,
): Effect.Effect<CapabilityReport> =>
  Effect.gen(function*() {
    const enabledIn = <T>(list: ReadonlyArray<T>, value: T) => list.includes(value);

    // Cloudflare deploy target (also backs D1 + R2).
    const cfMissing: Array<string> = [];
    if (config.cloudflare === undefined) cfMissing.push("CLOUDFLARE_ACCOUNT_ID");
    else {
      if (config.cloudflare.alchemyHome === "") cfMissing.push("ALCHEMY_HOME");
      if (config.cloudflare.workersSubdomain === "") cfMissing.push("CLOUDFLARE_WORKERS_SUBDOMAIN");
      if (config.cloudflare.routerNamespaceId === "") cfMissing.push("ROUTER_KV_NAMESPACE_ID");
      if (config.cloudflare.zoneId === "") cfMissing.push("CLOUDFLARE_ZONE_ID");
    }
    const cfTokenMissing = yield* resolveMissing(secrets, ["CLOUDFLARE_API_TOKEN"]);
    const cfAllMissing = [...cfMissing, ...cfTokenMissing];
    const cloudflare = status(
      enabledIn(config.deployTargets, "cloudflare"),
      cfAllMissing,
      "Cloudflare config/credentials incomplete",
    );

    const aws = status(
      enabledIn(config.deployTargets, "aws"),
      config.aws === undefined ? ["AWS credentials (AWS_ACCESS_KEY_ID / AWS_PROFILE / IMDS)"] : [],
      "No AWS credentials discoverable",
    );

    // Database options. D1 only applies to the Cloudflare target, so it is
    // "enabled" whenever the Cloudflare target is — its credentials are the
    // Cloudflare target's. PlanetScale Hyperdrive is the cross-target option.
    const d1 = status(true, cloudflare.missing, cloudflare.reason);
    const psMissing: Array<string> = [];
    if (config.planetscale === undefined) psMissing.push("PLANETSCALE_HOST");
    else {
      if (config.planetscale.username === "") psMissing.push("PLANETSCALE_USERNAME");
      if (Redacted.value(config.planetscale.password) === "") psMissing.push("PLANETSCALE_PASSWORD");
      if (config.planetscale.database === "") psMissing.push("PLANETSCALE_DATABASE");
      if (config.planetscale.hyperdriveId === "") psMissing.push("CLOUDFLARE_HYPERDRIVE_ID");
    }
    const hyperdriveDb = status(
      config.database === "planetscale-hyperdrive" || enabledIn(config.features, "hyperdrive"),
      psMissing,
      "PlanetScale/Hyperdrive config incomplete",
    );

    // Features.
    const r2 = status(enabledIn(config.features, "r2"), cloudflare.missing, cloudflare.reason);
    const hyperdrive = status(
      enabledIn(config.features, "hyperdrive"),
      hyperdriveDb.missing,
      hyperdriveDb.reason,
    );

    // Auth-server providers.
    const logtoMissing: Array<string> = [];
    if (config.logto === undefined) logtoMissing.push("LOGTO_M2M_APP_ID");
    else if (config.logto.clientSecret === "") logtoMissing.push("LOGTO_M2M_APP_SECRET");
    const logtoCap = status(config.authProvider === "logto", logtoMissing, "Logto M2M credentials incomplete");

    const workosMissing: Array<string> = [];
    if (config.workos === undefined) workosMissing.push("WORKOS_CLIENT_ID");
    else if (Redacted.value(config.workos.apiKey) === "") workosMissing.push("WORKOS_API_KEY");
    const workosCap = status(config.authProvider === "workos", workosMissing, "WorkOS credentials incomplete");

    return {
      deployTargets: { cloudflare, aws },
      database: { "cf-d1": d1, "planetscale-hyperdrive": hyperdriveDb },
      features: { r2, hyperdrive },
      authProviders: { logto: logtoCap, workos: workosCap },
    };
  });

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class PlatformConfigService extends Context.Service<PlatformConfigService, PlatformConfig>()(
  "@terrarium/control-plane/config/PlatformConfig",
) {
  /** Parse the declarative config and assemble the full PlatformConfig. A
   *  `Config` IS an `Effect<T, ConfigError>` that reads the ambient provider
   *  (process env by default), so we map it straight into the service. */
  static readonly layer: Layer.Layer<PlatformConfigService, Config.ConfigError> = Layer.effect(
    PlatformConfigService,
  )(Effect.map(flatConfig, makePlatformConfig));
}

/** Parse the full PlatformConfig once at boot (used by main.ts before layers). */
export const loadPlatformConfig: Effect.Effect<PlatformConfig, Config.ConfigError> = Effect.map(
  flatConfig,
  makePlatformConfig,
);
