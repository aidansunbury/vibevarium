import { createServer } from "node:http"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Auth, CurrentActor, requireAuth } from "@terrarium/auth"
import type { Actor } from "@terrarium/auth"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ConnectionsService, HttpError } from "./service.ts"
import type { AppRegistration } from "./service.ts"
import { ConnectionsStore } from "./store.ts"
import type { ConnectionsStoreOptions, ProviderRegistration } from "./store.ts"

export interface ConnectionsServerOptions {
  readonly port?: number | undefined
  readonly host?: string | undefined
  readonly oidc: {
    readonly issuer: string
    readonly audience: string
  }
  readonly apps: ReadonlyArray<AppRegistration>
  readonly providers?: ReadonlyArray<ProviderRegistration> | undefined
  readonly database?: ConnectionsStoreOptions | undefined
  readonly refreshSkewMs?: number | undefined
}

export interface ConnectionsServer {
  readonly baseUrl: string
  readonly port: number
  readonly store: ConnectionsStore
  readonly registerProvider: (registration: ProviderRegistration) => Promise<void>
  readonly close: () => Promise<void>
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  })

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  })

const errorResponse = (error: unknown) => {
  if (error instanceof HttpError) {
    return json({
      error: error.code,
      error_description: error.message,
      ...error.details
    }, error.status, error.status === 401 ? { "www-authenticate": 'Basic realm="terrarium-app"' } : {})
  }
  return json({ error: "internal_error", error_description: "Internal connections error" }, 500)
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new HttpError(400, "invalid_json", "Expected a valid JSON body")
  }
}

const requestUrl = (request: HttpServerRequest) => new URL(request.url, "http://connections.local")

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;")

const toNodeResponse = async (response: Response) => HttpServerResponse.uint8Array(
  new Uint8Array(await response.arrayBuffer()),
  { status: response.status, headers: Object.fromEntries(response.headers) }
)

const textRoute = (
  run: (request: HttpServerRequest, body: string) => Promise<Response>
) => Effect.gen(function*() {
  const request = yield* HttpServerRequest
  const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")))
  return yield* Effect.promise(() => run(request, body).catch(errorResponse).then(toNodeResponse))
})

const userTextRoute = (
  run: (actor: Actor, request: HttpServerRequest, body: string) => Promise<Response>
) => requireAuth(Effect.gen(function*() {
  const actor = yield* CurrentActor
  return yield* textRoute((request, body) => run(actor, request, body))
}))

const userJsonRoute = (
  run: (actor: Actor, body: unknown) => Promise<unknown>
) => userTextRoute(async (actor, _request, body) => json(await run(actor, parseJson(body))))

const appJsonRoute = (
  service: ConnectionsService,
  run: (app: AppRegistration, body: unknown) => Promise<unknown>
) => textRoute(async (request, body) => {
  const app = service.authenticateApp(request.headers.authorization)
  return json(await run(app, parseJson(body)))
})

const consentHtml = (view: Awaited<ReturnType<ConnectionsService["consent"]>>) => {
  const appName = view.grant.appId
  const scopes = view.grant.scopes.split(/\s+/).filter(Boolean)
  return `<!doctype html>
<html><head><title>Terrarium connection consent</title></head><body>
<h1>Connection consent</h1>
<p><strong>App ${escapeHtml(appName)} wants your ${escapeHtml(view.client.displayName)} (${scopes.map(escapeHtml).join(", ")})</strong>.</p>
<p>Connected account: ${escapeHtml(view.connection.providerAccountLabel)}</p>
<p>Signed in as: ${escapeHtml(view.actor.name ?? view.actor.sub)}</p>
<form method="post" action="/grants/decision">
<input type="hidden" name="grant" value="${escapeHtml(view.grant.id)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>`
}

export const startConnectionsServer = async (options: ConnectionsServerOptions): Promise<ConnectionsServer> => {
  const store = await ConnectionsStore.open(options.database)
  const service = new ConnectionsService({ store, apps: options.apps, refreshSkewMs: options.refreshSkewMs })
  try {
    for (const provider of options.providers ?? []) await store.registerProvider(provider)

    const routes = HttpRouter.use((router) => Effect.gen(function*() {
      yield* router.add("GET", "/health", textRoute(async () => json({ ok: true, service: "connections" })))
      yield* router.add("POST", "/connections/start", userJsonRoute((actor, body) => service.startConnection(actor, body)))
      const callback = textRoute(async (request, body) => {
        const url = requestUrl(request)
        const params = request.method === "POST" ? new URLSearchParams(body) : url.searchParams
        const connection = await service.completeConnection(params)
        if (request.headers.accept?.includes("text/html")) {
          return html(`<!doctype html><title>Connected</title><h1>Connected ${escapeHtml(connection.provider)}</h1><p>Account: ${escapeHtml(connection.provider_account.label)}</p><p>Connection ID: ${connection.connection_id}</p>`)
        }
        return json(connection)
      })
      yield* router.add("GET", "/connections/callback", callback)
      yield* router.add("POST", "/connections/callback", callback)
      yield* router.add("POST", "/connections/revoke", userJsonRoute((actor, body) => service.revokeConnection(actor, body)))
      yield* router.add("POST", "/grants/request", appJsonRoute(service, (app, body) => service.requestGrant(app, body)))
      yield* router.add("GET", "/grants/consent", userTextRoute(async (actor, request) => {
        const grantId = requestUrl(request).searchParams.get("grant") ?? ""
        return html(consentHtml(await service.consent(actor, grantId)))
      }))
      yield* router.add("POST", "/grants/decision", userTextRoute(async (actor, request, body) => {
        const decision = await service.decideGrant(actor, Object.fromEntries(new URLSearchParams(body)))
        if (request.headers.accept?.includes("application/json")) return json(decision)
        if (decision.status === "denied") return html("<!doctype html><title>Denied</title><h1>Grant denied</h1>")
        return html(`<!doctype html><title>Approved</title><h1>Grant approved</h1><p data-grant-id="${decision.grant.grant_id}">Grant ${decision.grant.grant_id} is approved.</p>`)
      }))
      yield* router.add("POST", "/grants/revoke", userJsonRoute((actor, body) => service.revokeGrant(actor, body)))
      yield* router.add("POST", "/vend", appJsonRoute(service, (app, body) => service.vend(app, body)))
      yield* router.add("*", "/proxy/*", Effect.gen(function*() {
        const request = yield* HttpServerRequest
        const body = yield* request.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
        const response = yield* Effect.promise(() => (async () => {
          const app = service.authenticateApp(request.headers.authorization)
          const url = requestUrl(request)
          const match = url.pathname.match(/^\/proxy\/([^/]+)(?:\/(.*))?$/)
          if (!match?.[1]) throw new HttpError(404, "not_found", "Expected /proxy/:provider/*")
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(request.headers)) {
            if (typeof value === "string") headers[name] = value
          }
          return service.proxy({
            app,
            provider: decodeURIComponent(match[1]),
            path: match[2] ?? "",
            query: url.search,
            method: request.method,
            headers,
            body
          })
        })().catch(errorResponse).then(toNodeResponse))
        return response
      }))
    }))

    const serverLayer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(Auth.layer(options.oidc)),
      Layer.provideMerge(NodeHttpServer.layer(createServer, {
        port: options.port ?? 0,
        host: options.host ?? "127.0.0.1"
      }))
    )
    const runtime = ManagedRuntime.make(serverLayer)
    try {
      const server = await runtime.runPromise(HttpServer.HttpServer)
      const baseUrl = HttpServer.formatAddress(server.address).replace(/\/+$/, "")
      service.setBaseUrl(baseUrl)
      return {
        baseUrl,
        port: Number(new URL(baseUrl).port),
        store,
        registerProvider: async (registration) => {
          await store.registerProvider(registration)
        },
        close: async () => {
          await runtime.dispose()
          await store.close()
        }
      }
    } catch (error) {
      await runtime.dispose()
      throw error
    }
  } catch (error) {
    await store.close()
    throw error
  }
}
