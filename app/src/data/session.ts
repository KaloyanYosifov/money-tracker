import * as Device from "expo-device";
import { createContext, useContext } from "react";
import { Alert, Platform } from "react-native";

import type { UserChangeHandler } from "../auth/AuthProvider";
import { API_URL } from "../config";

/** The part of the PowerSync database that the session actions use. */
export interface SessionDb {
  getOptional<T>(sql: string, parameters?: unknown[]): Promise<T | null>;
  disconnectAndClear(): Promise<void>;
}

/** Asks the user. Resolves true when the user picks the action. */
export type Confirm = (message: string, actionLabel: string) => Promise<boolean>;

export function unsyncedMessage(count: number): string {
  return count === 1
    ? "1 change is not synced yet and will be lost"
    : `${count} changes are not synced yet and will be lost`;
}

/** ps_crud is the PowerSync upload queue. */
async function pendingChanges(db: SessionDb): Promise<number> {
  const row = await db.getOptional<{ n: number }>("SELECT count(*) AS n FROM ps_crud");
  return row?.n ?? 0;
}

async function confirmLoss(db: SessionDb, confirm: Confirm, actionLabel: string): Promise<boolean> {
  const pending = await pendingChanges(db);
  return pending === 0 || confirm(unsyncedMessage(pending), actionLabel);
}

/**
 * Ends the session on the server, forgets the tokens and deletes the local
 * database. Returns false when the user cancels.
 */
export async function logout(deps: { db: SessionDb; signOut: () => Promise<void>; confirm: Confirm }): Promise<boolean> {
  if (!(await confirmLoss(deps.db, deps.confirm, "Log out"))) return false;
  // The local data goes first, so that a slow or offline API call does not keep it.
  await deps.db.disconnectAndClear();
  await deps.signOut();
  return true;
}

/** Deletes the local database and downloads everything again. Returns false when the user cancels. */
export async function resetLocalData(deps: {
  db: SessionDb;
  connect: () => Promise<void>;
  confirm: Confirm;
}): Promise<boolean> {
  if (!(await confirmLoss(deps.db, deps.confirm, "Reset"))) return false;
  await deps.db.disconnectAndClear();
  await deps.connect();
  return true;
}

/** The AuthProvider onUserChange handler: the data of the previous user never shows for the next one. */
export function clearOnUserChange(db: SessionDb): UserChangeHandler {
  return async () => {
    await db.disconnectAndClear();
  };
}

export const confirmDialog: Confirm = (message, actionLabel) => {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${message}. ${actionLabel}?`));
  }
  return new Promise((resolve) => {
    Alert.alert(actionLabel, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: actionLabel, style: "destructive", onPress: () => resolve(true) },
    ]);
  });
};

export interface SessionActions {
  logout(): Promise<boolean>;
  resetLocalData(): Promise<boolean>;
}

/** The root layout provides the actions bound to the database, the auth state and the connector. */
export const SessionActionsContext = createContext<SessionActions | null>(null);

export function useSessionActions(): SessionActions {
  const value = useContext(SessionActionsContext);
  if (!value) throw new Error("useSessionActions needs a SessionActionsContext");
  return value;
}

export interface DeviceSession {
  id: string;
  device_name: string;
  created_at: string;
  last_used_at: string;
  /** The API knows the current session only on the web, from the cookie. */
  current: boolean;
}

export type SessionsResult<T> = { ok: true; value: T } | { ok: false; error: "unauthorized" | "network" | "server" };

export interface SessionsApi {
  list(): Promise<SessionsResult<DeviceSession[]>>;
  revoke(sessionId: string): Promise<SessionsResult<void>>;
}

export function createSessionsApi(options: {
  apiUrl?: string;
  platform?: "native" | "web";
  getAccessToken: () => Promise<string | null>;
}): SessionsApi {
  const apiUrl = options.apiUrl ?? API_URL;
  const isNative = (options.platform ?? (Platform.OS === "web" ? "web" : "native")) === "native";

  async function call(method: "GET" | "DELETE", path: string): Promise<SessionsResult<unknown>> {
    const token = await options.getAccessToken();
    if (!token) return { ok: false, error: "unauthorized" };
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (isNative) {
      headers["X-Client"] = "native";
      headers["X-Device-Name"] = Device.modelName ?? "iOS device";
    } else {
      headers["X-Requested-With"] = "money-tracker";
    }
    let res: Response;
    try {
      res = await fetch(apiUrl + path, { method, headers, credentials: isNative ? undefined : "include" });
    } catch {
      return { ok: false, error: "network" };
    }
    if (res.status === 401) return { ok: false, error: "unauthorized" };
    if (!res.ok) return { ok: false, error: "server" };
    try {
      return { ok: true, value: res.status === 204 ? undefined : await res.json() };
    } catch {
      return { ok: false, error: "server" };
    }
  }

  return {
    async list() {
      const result = await call("GET", "/api/auth/sessions");
      if (!result.ok) return result;
      return { ok: true, value: (result.value as { sessions: DeviceSession[] }).sessions };
    },
    async revoke(sessionId) {
      const result = await call("DELETE", `/api/auth/sessions/${encodeURIComponent(sessionId)}`);
      return result.ok ? { ok: true, value: undefined } : result;
    },
  };
}
