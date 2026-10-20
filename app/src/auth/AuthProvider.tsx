import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";

import { authApi, type AuthApi, type TokenResponse } from "./api";
import * as tokenStore from "./tokenStore";

export type AuthStatus = "loading" | "signedOut" | "signedIn" | "reauthRequired";

export interface AuthContextValue {
  status: AuthStatus;
  /** The signed-in user, or the last known user in reauthRequired. */
  userId: string | null;
  /** The refresh token family of this device, from the last token response. Null before one. */
  sessionId: string | null;
  /** Returns a valid access token, or null if none can be had now. */
  getAccessToken(): Promise<string | null>;
  /** Gets a new access token even if the cached one is still valid. Null if the refresh failed. */
  refreshAccessToken(): Promise<string | null>;
  /** Stores the token response of a finished login or invite confirm. */
  signIn(tokens: TokenResponse): Promise<void>;
  /** On the web it rejects if the server did not end the session. */
  signOut(): Promise<void>;
}

/** Called with the new and the previous user ID, before the new user is published. */
export type UserChangeHandler = (nextUserId: string, previousUserId: string | null) => void | Promise<void>;

/** Called when the server says that the session was revoked, before the user is signed out. */
export type SessionRevokedHandler = () => void | Promise<void>;

const REFRESH_MARGIN_MS = 60_000;

type RefreshOutcome = { kind: "ok"; tokens: TokenResponse } | { kind: "invalid" } | { kind: "failed" };

const AuthContext = createContext<AuthContextValue | null>(null);

type LockManager = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };

/**
 * Browser tabs share one refresh cookie, and the server revokes the session when a
 * rotated token comes again. A Web Lock makes the tabs refresh one after the other,
 * so each tab sends the newest cookie.
 */
function acrossTabs<T>(callback: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  return locks ? locks.request("money-tracker-refresh", callback) : callback();
}

export function AuthProvider({
  children,
  api = authApi,
  onUserChange,
  onSessionRevoked,
  now = Date.now,
}: {
  children: ReactNode;
  api?: AuthApi;
  onUserChange?: UserChangeHandler;
  onSessionRevoked?: SessionRevokedHandler;
  now?: () => number;
}) {
  const [state, setState] = useState<{ status: AuthStatus; userId: string | null; sessionId: string | null }>({
    status: "loading",
    userId: null,
    sessionId: null,
  });
  const access = useRef<{ token: string; expiresAt: number } | null>(null);
  const inflight = useRef<Promise<RefreshOutcome> | null>(null);
  // Props in refs keep the callbacks stable, so inline props do not restart the effect.
  const props = useRef({ api, onUserChange, onSessionRevoked, now });
  useLayoutEffect(() => {
    props.current = { api, onUserChange, onSessionRevoked, now };
  });

  const keepTokens = useCallback(
    async (tokens: TokenResponse) => {
      if (tokens.refresh_token) {
        await tokenStore.setRefreshToken(tokens.refresh_token);
      }
      await tokenStore.setLastUserId(tokens.user_id);
      access.current = { token: tokens.access_token, expiresAt: props.current.now() + tokens.expires_in * 1000 };
    },
    [],
  );

  const refresh = useCallback((): Promise<RefreshOutcome> => {
    if (inflight.current) {
      return inflight.current;
    }
    const run = async (): Promise<RefreshOutcome> => {
      const stored = await tokenStore.getRefreshToken();
      // Native keeps the token in the Keychain. Without it, no refresh can work.
      const result =
        stored === null && Platform.OS !== "web"
          ? ({ ok: false, error: "refresh_invalid" } as const)
          : await acrossTabs(() => props.current.api.refresh(stored));

      if (result.ok) {
        await keepTokens(result.value);
        setState({ status: "signedIn", userId: result.value.user_id, sessionId: result.value.session_id });
        return { kind: "ok", tokens: result.value };
      }
      if (result.error === "refresh_invalid") {
        access.current = null;
        await tokenStore.setRefreshToken(null);
        const last = await tokenStore.getLastUserId();
        setState({ status: last ? "reauthRequired" : "signedOut", userId: last, sessionId: null });
        return { kind: "invalid" };
      }
      if (result.error === "session_revoked") {
        // A lost device or a revoke from another device: the local data goes too.
        access.current = null;
        await tokenStore.setRefreshToken(null);
        await props.current.onSessionRevoked?.();
        await tokenStore.setLastUserId(null);
        setState({ status: "signedOut", userId: null, sessionId: null });
        return { kind: "invalid" };
      }
      return { kind: "failed" };
    };
    inflight.current = run().finally(() => {
      inflight.current = null;
    });
    return inflight.current;
  }, [keepTokens]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const outcome = await refresh();
      if (outcome.kind !== "failed" || cancelled) {
        return;
      }
      // Offline start: a known user keeps using the local data.
      const last = await tokenStore.getLastUserId();
      setState({ status: last ? "signedIn" : "signedOut", userId: last, sessionId: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const current = access.current;
    if (current && props.current.now() < current.expiresAt - REFRESH_MARGIN_MS) {
      return current.token;
    }
    const outcome = await refresh();
    return outcome.kind === "ok" ? outcome.tokens.access_token : null;
  }, [refresh]);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const outcome = await refresh();
    return outcome.kind === "ok" ? outcome.tokens.access_token : null;
  }, [refresh]);

  const signIn = useCallback(
    async (tokens: TokenResponse) => {
      const previous = await tokenStore.getLastUserId();
      if (previous !== tokens.user_id) {
        await props.current.onUserChange?.(tokens.user_id, previous);
      }
      await keepTokens(tokens);
      setState({ status: "signedIn", userId: tokens.user_id, sessionId: tokens.session_id });
    },
    [keepTokens],
  );

  const signOut = useCallback(async () => {
    const result = await props.current.api.logout(await tokenStore.getRefreshToken());
    // On the web the refresh token is an HttpOnly cookie that only the server can clear.
    // If the call fails, the next person at this browser can still resume the session.
    if (!result.ok && Platform.OS === "web") {
      throw new Error(`logout failed: ${result.error}`);
    }
    access.current = null;
    await tokenStore.setRefreshToken(null);
    await tokenStore.setLastUserId(null);
    setState({ status: "signedOut", userId: null, sessionId: null });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, getAccessToken, refreshAccessToken, signIn, signOut }),
    [state, getAccessToken, refreshAccessToken, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth needs an AuthProvider");
  }
  return value;
}
