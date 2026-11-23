/**
 * The auth gate, used by the root route's `beforeLoad` (replacing the old
 * boot `useEffect` bounce). Discovers the Worker's auth mode from the public
 * `/auth/status`; when auth is on it requires the session actor from
 * `/auth/me` and bounces to the hosted sign-in on a 401. There is no
 * logged-out UI state — a route either renders authed or the browser is
 * already on its way to the issuer.
 */
import { api, isUnauthenticated, redirectToLogin } from "./client";

export interface Session {
  readonly authEnabled: boolean;
  readonly actor: { readonly sub: string; readonly name?: string } | null;
}

export const loadSession = async (): Promise<Session> => {
  let enabled = false;
  try {
    enabled = (await api.auth.status()).enabled;
  } catch {
    enabled = false;
  }
  if (!enabled) return { authEnabled: false, actor: null };
  try {
    const me = await api.auth.me();
    return { authEnabled: true, actor: me.actor };
  } catch (error) {
    if (isUnauthenticated(error)) {
      // Hard navigation away — never resolve the route unauthenticated.
      redirectToLogin();
      await new Promise<never>(() => {});
    }
    throw error;
  }
};
