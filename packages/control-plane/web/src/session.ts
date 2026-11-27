/**
 * The auth gate, used by the root route's `beforeLoad`. Resolves the session
 * actor from `GET /auth/me` (cookie-first). Unlike the app template (which
 * hard-bounces on any 401), the control plane shows a sign-in card when auth
 * is on but there's no session — matching its existing UX — while auth-off
 * dev mode (`{ auth: "off" }`) renders straight through.
 */
import { api, isUnauthenticated, isSessionExpired } from "./api";

export interface Session {
  readonly authOn: boolean;
  readonly actor: { readonly sub: string; readonly name?: string } | null;
  readonly isSuperadmin: boolean;
}

export const loadSession = async (): Promise<Session> => {
  try {
    const me = await api.me();
    const authOn = me.auth === "on";
    return {
      authOn,
      actor: me.actor,
      isSuperadmin: authOn ? Boolean(me.isSuperadmin) : true,
    };
  } catch (error) {
    if (isUnauthenticated(error) || isSessionExpired(error)) {
      return { authOn: true, actor: null, isSuperadmin: false };
    }
    throw error;
  }
};
