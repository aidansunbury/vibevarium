import type { CallRejected, Cliable } from "@alchemy.run/domain/Cli";
import { toCli } from "@alchemy.run/domain/Cli";
import { callName, operationsOf } from "@alchemy.run/domain/ReadRpcs";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import { cliName } from "./name.ts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { authCommands, ssoHeaders, ssoProtocolHttp } from "./auth.ts";
import { appsFile, readJsonFile, rpcUrl, writeJsonFile } from "./config.ts";
import { control } from "./control.ts";
import { embeddedApis } from "./registry.ts";

const AppEntry = Schema.Struct({
  // The domain package's published name (must be present in the embedded
  // registry for this CLI build), for example "@vibevarium/template".
  package: Schema.String,
  url: Schema.String,
  api: Schema.optional(Schema.String),
  expose: Schema.optional(Schema.Array(Schema.String)),
});

const Manifest = Schema.Record(Schema.String, AppEntry);

type AppEntry = typeof AppEntry.Type;
type Manifest = typeof Manifest.Type;

const decodeManifest = Schema.decodeUnknownSync(Manifest);

const userError = (message: string, cause: unknown = message) =>
  new CliError.UserError({ cause, userMessage: message });

export const readManifest = Effect.tryPromise({
  try: async (): Promise<Manifest> => {
    const value = await readJsonFile(appsFile);
    return value === undefined ? {} : decodeManifest(value);
  },
  catch: (cause) => userError(`Could not read ${appsFile}: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
});

export const addApp = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(
      Argument.withSchema(
        Schema.String.check(
          Schema.isPattern(/^[a-z][a-z0-9-]*$/),
          // `control` is the platform's reserved control-surface alias.
          Schema.makeFilter((name: string) =>
            name === "control"
              ? `"control" is reserved for the platform control surface (the \`control\` subtree)`
              : undefined
          ),
        ),
      ),
      Argument.withDescription("Subcommand name, for example tickets (`control` is reserved)"),
    ),
    package: Argument.String("package").pipe(
      Argument.withDescription("Domain package name from this build's embedded registry"),
    ),
    url: Argument.String("url").pipe(Argument.withDescription("Deployed app base URL")),
  },
  Effect.fn(function* ({ name, package: packageName, url }) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (cause) {
      return yield* userError(`Invalid app URL: ${url}`, cause);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* userError("App URL must use HTTP or HTTPS");
    }
    // A bun-compiled binary has no node_modules and cannot import a bare
    // specifier at runtime, so domain packages are embedded at build time and
    // selected here by name. Fail fast on an unknown package.
    if (!(packageName in embeddedApis)) {
      const known = Object.keys(embeddedApis).join(", ") || "none";
      return yield* userError(
        `${packageName} is not embedded in this CLI build. Available: ${known}`,
      );
    }
    const manifest = yield* readManifest;
    const next = {
      ...manifest,
      [name]: { package: packageName, url: parsed.toString().replace(/\/+$/, "") },
    };
    yield* Effect.tryPromise({
      try: () => writeJsonFile(appsFile, next),
      catch: (cause) => userError(`Could not write ${appsFile}: ${String(cause)}`, cause),
    });
    return yield* Console.log(`Added ${name}: ${packageName} at ${next[name].url}`);
  }),
).pipe(Command.withDescription("Register an embedded domain package in apps.json"));

const isCliable = (value: unknown): value is Cliable => {
  if (
    !Predicate.isObjectKeyword(value) ||
    !Predicate.hasProperty("apiName")(value) ||
    !Predicate.hasProperty("annotations")(value) ||
    !Predicate.hasProperty("serves")(value) ||
    !Predicate.hasProperty("group")(value) ||
    !Predicate.hasProperty("client")(value)
  ) {
    return false;
  }
  const candidate = value as {
    readonly apiName: unknown;
    readonly serves: unknown;
    readonly client: unknown;
  };
  return (
    typeof candidate.apiName === "string" &&
    Array.isArray(candidate.serves) &&
    Effect.isEffect(candidate.client)
  );
};

/**
 * The published CLI embeds the platform's domain Apis (see registry.ts)
 * because a bun-compiled binary cannot import bare package specifiers at
 * runtime. The manifest selects one by package + Api name.
 */
const importApi = async (name: string, entry: AppEntry): Promise<Cliable> => {
  const module = embeddedApis[entry.package];
  if (module === undefined) {
    const known = Object.keys(embeddedApis).join(", ") || "none";
    throw new Error(`${entry.package} is not embedded in this CLI build. Available: ${known}`);
  }
  if (entry.api !== undefined) {
    const selected = module[entry.api];
    if (!isCliable(selected)) {
      throw new Error(`${entry.package}#${entry.api} is not an Api with the Cliable runtime shape`);
    }
    return selected;
  }
  const candidates = Object.entries(module).filter(
    (candidate): candidate is [string, Cliable] => isCliable(candidate[1]),
  );
  if (candidates.length !== 1) {
    const names = candidates.map(([exportName]) => exportName).join(", ") || "none";
    throw new Error(
      `${entry.package} for ${name} must have exactly one Api export when manifest 'api' is omitted; found ${names}`,
    );
  }
  return candidates[0][1];
};

const defaultExpose = (api: Cliable) =>
  operationsOf(api.serves)
    .filter((operation) => !operation.stream)
    .map(callName);

const appCommand = (name: string, entry: AppEntry) =>
  Effect.gen(function* () {
    const api = yield* Effect.tryPromise({
      try: () => importApi(name, entry),
      catch: (cause) => userError(`Could not load app ${name}: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
    });
    // This is the deliberate untyped boundary: only the runtime Cliable shape survives import().
    const command: Command.Command<
      string,
      unknown,
      {},
      CallRejected | CliError.UserError,
      HttpClient.HttpClient
    > = toCli(api, {
      name,
      // Exposable<Cliable> is never because its client is unknown; runtime expose names are strings.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      expose: (entry.expose ?? defaultExpose(api)) as never,
      headers: ssoHeaders,
    }).pipe(Command.provide(ssoProtocolHttp(rpcUrl(entry.url))));
    return command;
  });

export const dynamicPlatform = Effect.gen(function* () {
  const manifest = yield* readManifest;
  const appCommands = [];
  for (const [name, entry] of Object.entries(manifest)) {
    appCommands.push(yield* appCommand(name, entry));
  }
  const apps = Command.make("apps").pipe(
    Command.withSubcommands([addApp]),
    Command.withDescription("Manage the dynamic app manifest"),
  );
  return Command.make(cliName).pipe(
    Command.withSubcommands([...authCommands, apps, control, ...appCommands]),
    Command.withDescription("One SSO login for dynamically imported Vibevarium apps"),
  );
});
