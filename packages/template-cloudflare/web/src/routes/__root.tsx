import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { loadSession, type Session } from "../session";

export interface RouterContext {
  readonly queryClient: QueryClient;
}

/**
 * The root route IS the auth guard: before any route renders, `beforeLoad`
 * resolves the session (/auth/status → /auth/me); a 401 navigates to the
 * hosted sign-in and never resolves, so no child route ever renders
 * logged-out. The session lands in the route context, available to every
 * child via `getRouteApi("__root__").useRouteContext()`.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async (): Promise<{ session: Session }> => ({ session: await loadSession() }),
  component: Outlet,
});

export const useSession = (): Session => Route.useRouteContext().session;
