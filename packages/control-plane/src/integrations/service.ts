import { and, desc, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { Database } from "../store/database.ts";
import { integrationGrants, integrations, proxyAudit, type IntegrationRow, type ProxyAuditRow } from "../store/schema.ts";
import { SecretsProvider } from "./secrets.ts";
import { ConnectionsConfigService, type ProxiedSecretConfig } from "../config/connections-schema.ts";

export class IntegrationError extends Schema.TaggedError<IntegrationError>()("IntegrationError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

export interface IntegrationView {
  readonly name: string;
  readonly displayName: string;
  readonly logoUrl?: string | undefined;
  readonly baseUrl: string;
  /** Stable config slug for the shared credential. */
  readonly secret: string;
  readonly tokenEnv: string;
  readonly authHeader: string;
  readonly timeoutMs: number;
  readonly tokenConfigured: boolean;
  readonly createdAt: string;
}

export interface ProxyCall {
  readonly callerKind: "user" | "app";
  readonly caller: string;
  readonly app: string;
  readonly integration: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ProxyResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const toView = (row: IntegrationRow, tokenConfigured: boolean, definition?: ProxiedSecretConfig): IntegrationView => ({
  name: row.name,
  displayName: definition?.displayName ?? row.name,
  ...(definition?.logoUrl === undefined ? {} : { logoUrl: definition.logoUrl }),
  baseUrl: row.baseUrl,
  secret: definition?.secret ?? row.tokenEnv,
  tokenEnv: row.tokenEnv,
  authHeader: row.authHeader,
  timeoutMs: Number.parseInt(row.timeoutMs, 10),
  tokenConfigured,
  createdAt: row.createdAt,
});

export class Integrations extends Context.Service<Integrations, {
  readonly list: () => Effect.Effect<ReadonlyArray<IntegrationView>>;
  readonly grant: (app: string, integration: string) => Effect.Effect<void, IntegrationError>;
  readonly revoke: (app: string, integration: string) => Effect.Effect<void, IntegrationError>;
  readonly grants: () => Effect.Effect<ReadonlyArray<{ readonly app: string; readonly integration: string }>>;
  readonly proxy: (call: ProxyCall) => Effect.Effect<ProxyResult>;
  readonly audit: (
    integration: string | undefined,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ProxyAuditRow>>;
}>()("@vibevarium/control-plane/integrations/Integrations") {
  static readonly layer = Layer.effect(Integrations)(Effect.gen(function*() {
    const { db } = yield* Database;
    const secrets = yield* SecretsProvider;
    const connectionsConfig = yield* ConnectionsConfigService;
    const definitions = new Map(Object.entries(connectionsConfig.config.proxiedSecrets));

    const fail = (status: number, code: string, message: string) =>
      Effect.fail(new IntegrationError({ status, code, message }));

    // Static config is authoritative. DB rows are only FK parents for grants;
    // stale runtime-created rows are neither listed nor executable.
    for (const [name, definition] of definitions) {
      const values = {
        baseUrl: definition.baseUrl.replace(/\/+$/, ""),
        tokenEnv: connectionsConfig.secretRef(definition.secret)!,
        authHeader: definition.authHeader ?? "authorization_bearer",
        timeoutMs: String(definition.timeoutMs ?? 10_000),
      };
      yield* Effect.promise(() =>
        db.insert(integrations).values({ name, ...values }).onConflictDoUpdate({
          target: integrations.name,
          set: values,
        })
      );
    }
    const view = (row: IntegrationRow, tokenConfigured: boolean) =>
      toView(row, tokenConfigured, definitions.get(row.name));

    const list = Effect.fnUntraced(function*() {
      const rows = yield* Effect.promise(() => db.select().from(integrations));
      return yield* Effect.forEach(rows.filter((row) => definitions.has(row.name)), (row) =>
        Effect.map(secrets.resolve(row.tokenEnv), (token) => view(row, Option.isSome(token)))
      );
    });

    const getRow = Effect.fnUntraced(function*(name: string) {
      if (!definitions.has(name)) return Option.none<IntegrationRow>();
      const rows = yield* Effect.promise(() =>
        db.select().from(integrations).where(eq(integrations.name, name)).limit(1)
      );
      return Option.fromUndefinedOr(rows[0]);
    });

    const grant = Effect.fnUntraced(function*(app: string, integration: string) {
      if (!namePattern.test(app)) {
        return yield* fail(400, "invalid_app", "App names are lower-kebab-case");
      }
      const existing = yield* getRow(integration);
      if (Option.isNone(existing)) {
        return yield* fail(404, "not_found", `Integration ${integration} is not registered`);
      }
      yield* Effect.promise(() =>
        db.insert(integrationGrants).values({ app, integration }).onConflictDoNothing()
      );
    });

    const revoke = Effect.fnUntraced(function*(app: string, integration: string) {
      yield* Effect.promise(() =>
        db.delete(integrationGrants).where(
          and(eq(integrationGrants.app, app), eq(integrationGrants.integration, integration)),
        )
      );
    });

    const grants = Effect.fnUntraced(function*() {
      const rows = yield* Effect.promise(() => db.select().from(integrationGrants));
      return rows.map((row) => ({ app: row.app, integration: row.integration }));
    });

    const hasGrant = Effect.fnUntraced(function*(app: string, integration: string) {
      const rows = yield* Effect.promise(() =>
        db.select().from(integrationGrants).where(
          and(eq(integrationGrants.app, app), eq(integrationGrants.integration, integration)),
        ).limit(1)
      );
      return rows.length > 0;
    });

    const auditRows = Effect.fnUntraced(function*(integration: string | undefined, limit: number) {
      const base = db.select().from(proxyAudit).orderBy(desc(proxyAudit.at)).limit(limit);
      return yield* Effect.promise(() =>
        integration === undefined ? base : base.where(eq(proxyAudit.integration, integration))
      );
    });

    const hopByHop = new Set([
      "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
      "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    ]);

    const recordAudit = (
      call: ProxyCall,
      status: string,
      durationMs: number,
    ) =>
      Effect.promise(() =>
        db.insert(proxyAudit).values({
          id: randomUUID(),
          callerKind: call.callerKind,
          caller: call.caller,
          app: call.app,
          integration: call.integration,
          method: call.method,
          path: call.path,
          status,
          durationMs: String(durationMs),
        })
      ).pipe(Effect.ignore);

    const proxy = Effect.fnUntraced(function*(call: ProxyCall) {
      const started = Date.now();
      const integrationRow = yield* getRow(call.integration);
      if (Option.isNone(integrationRow)) {
        return {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: new TextEncoder().encode(JSON.stringify({
            error: "unknown_integration",
            error_description: `Integration ${call.integration} is not registered`,
          })),
        } satisfies ProxyResult;
      }
      const row = integrationRow.value;

      const granted = yield* hasGrant(call.app, call.integration);
      if (!granted) {
        yield* recordAudit(call, "403 grant_required", 0);
        return {
          status: 403,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: new TextEncoder().encode(JSON.stringify({
            error: "grant_required",
            error_description: `App ${call.app} has no grant for integration ${call.integration}`,
            app: call.app,
            integration: call.integration,
          })),
        } satisfies ProxyResult;
      }

      // SECRETS SEAM: resolved through the SecretsProvider service — v1 is env
      // vars (SecretsProvider.envLayer); AWS SM/Infisical/1Password replace the layer.
      const resolved = yield* secrets.resolve(row.tokenEnv);
      if (Option.isNone(resolved)) {
        yield* recordAudit(call, "502 secret_unavailable", 0);
        return {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: new TextEncoder().encode(JSON.stringify({
            error: "secret_unavailable",
            error_description: `The control plane has no token configured for ${call.integration} (env ${row.tokenEnv})`,
          })),
        } satisfies ProxyResult;
      }

      const token = resolved.value;
      const timeoutMs = Number.parseInt(row.timeoutMs, 10);
      const url = row.baseUrl + "/" + call.path;
      const outbound: Record<string, string> = {};
      for (const [name, value] of Object.entries(call.headers)) {
        if (!hopByHop.has(name)) outbound[name] = value;
      }
      delete outbound["authorization"];
      delete outbound["x-vibevarium-app"];
      delete outbound["x-vibevarium-app-secret"];
      if (row.authHeader === "authorization_bearer") outbound["authorization"] = `Bearer ${token}`;
      else if (row.authHeader === "authorization") outbound["authorization"] = token;
      else if (row.authHeader === "x-api-key") outbound["x-api-key"] = token;

      const send = Effect.tryPromise({
        try: async () => {
          const init: RequestInit = {
            method: call.method,
            headers: outbound,
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          };
          if (call.method !== "GET" && call.method !== "HEAD" && call.body.byteLength > 0) {
            init.body = call.body.slice();
          }
          const response = await fetch(url, init);
          const body = new Uint8Array(await response.arrayBuffer());
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            if (!hopByHop.has(name)) headers[name] = value;
          });
          return { status: response.status, headers, body } satisfies ProxyResult;
        },
        catch: () => "timeout_or_transport",
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            status: 504,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: new TextEncoder().encode(JSON.stringify({
              error: "upstream_error",
              error_description: `Integration ${call.integration} did not answer within ${timeoutMs}ms or is unreachable`,
            })),
          } satisfies ProxyResult)
        ),
      );

      const result = yield* send;
      yield* recordAudit(call, String(result.status), Date.now() - started);
      return result;
    });

    return Integrations.of({
      list,
      grant,
      revoke,
      grants,
      proxy,
      audit: auditRows,
    });
  }));
}
