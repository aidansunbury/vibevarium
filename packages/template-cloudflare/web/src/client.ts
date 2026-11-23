/**
 * The app's typed API client — Effect-generated, no hand-rolled fetch.
 *
 * `HttpApiClient.make` derives the client from the SAME `HttpApi` declaration
 * the Worker serves (`api/TicketsApi.ts`, vendored from the domain source), so
 * request/response types can never drift from the wire. Transport is
 * `FetchHttpClient` with `credentials: "same-origin"`: when auth is on, the
 * browser never holds a token — the Worker's auth-code + PKCE flow
 * (/auth/login → /auth/callback) sets an httpOnly session cookie and the API
 * accepts it first-party. Any 401 means the session is missing or expired —
 * the transport maps it to `UnauthenticatedError` and the caller bounces to
 * /auth/login, which 302s straight to the hosted sign-in. There is no
 * logged-out UI state.
 */
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { TicketsHttp, type CommandReceipt } from "./api/TicketsApi";

export { CommandReceipt, TicketNotFound, TicketSummary, type TicketListView } from "./api/TicketsApi";

/** The request was rejected as unauthenticated; the router bounces to /auth/login. */
export class UnauthenticatedError extends Error {
  readonly _tag = "UnauthenticatedError";
}

export const isUnauthenticated = (error: unknown): error is UnauthenticatedError =>
  error instanceof UnauthenticatedError ||
  (typeof error === "object" && error !== null && (error as { _tag?: string })._tag === "UnauthenticatedError");

/**
 * The cookie-first transport: `FetchHttpClient` with
 * `credentials: "same-origin"`, and a 401 response turned into a failed
 * `UnauthenticatedError` so the typed client surfaces session-expiry the same
 * way on every endpoint.
 */
const isSessionExpired = (error: unknown): error is { _tag: string; response: { status: number } } =>
  typeof error === "object" && error !== null &&
  (error as { _tag?: string })._tag === "ResponseError" &&
  (error as { response?: { status?: number } }).response?.status === 401;

const transport = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    // A 401 (session missing/expired) becomes a failed UnauthenticatedError on
    // every endpoint. The transform widens the error union beyond
    // HttpClientError, which HttpClient's types can't express — the `any` at
    // the boundary is deliberate and confined to this one transform.
    (client): HttpClient.HttpClient =>
      HttpClient.transformResponse(
        Effect.catchIf(
          isSessionExpired,
          () => Effect.fail(new UnauthenticatedError("the session is missing or expired")),
        ),
        // oxlint-disable-next-line typescript/no-explicit-any
      )(client as any) as HttpClient.HttpClient,
  ),
).pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" })),
    ),
  ),
);

const clientPromise = Effect.runPromise(
  Effect.provide(HttpApiClient.make(TicketsHttp), transport),
);

export const api = {
  tickets: {
    /** The ticket list; pass a command receipt to read your own write (atLeast). */
    list: (options?: { readonly atLeast?: CommandReceipt }) =>
      clientPromise.then((client) =>
        Effect.runPromise(
          client["TicketList.get"]({
            params: { key: "all" },
            query: options?.atLeast !== undefined
              ? { stream: options.atLeast.stream, version: options.atLeast.version }
              : {},
          }),
        ).then((view) => view ?? { tickets: [] }),
      ),

    open: (input: { readonly title: string; readonly reporter: string }) =>
      clientPromise.then((client) =>
        Effect.runPromise(
          client.OpenTicket({ payload: { input } }),
        ),
      ),

    close: (id: string) =>
      clientPromise.then((client) =>
        Effect.runPromise(
          client.CloseTicket({ payload: { target: id, input: {} } }),
        ),
      ),
  },

  // The Worker's auth seam — public discovery + the session actor. Not part of
  // the domain Api, but still typed, same-origin, cookie-first.
  auth: {
    status: (): Promise<{ enabled: boolean; issuer?: string }> =>
      fetch("/auth/status", { credentials: "same-origin" }).then((response) => response.json()),

    me: (): Promise<{ actor: { sub: string; name?: string } | null; auth: "on" | "off" }> =>
      fetch("/auth/me", { credentials: "same-origin" }).then(async (response) => {
        if (response.status === 401) throw new UnauthenticatedError("no session");
        if (!response.ok) throw new Error(`GET /auth/me failed with ${response.status}`);
        return response.json();
      }),
  },
};

/** Hard navigation to the login flow; the Worker 302s to the hosted sign-in. */
export const redirectToLogin = () => {
  window.location.assign("/auth/login");
};

/** Hard navigation to logout; the Worker clears the cookie and ends the provider session. */
export const redirectToLogout = () => {
  window.location.assign("/auth/logout");
};
