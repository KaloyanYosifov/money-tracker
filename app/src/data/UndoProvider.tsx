import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import type { SqlRunner } from "./mutations";

export const UNDO_DELAY_MS = 5000;

export interface UndoApi {
  /** Transactions that wait for their delete. Lists do not render them. */
  hiddenIds: ReadonlySet<string>;
  /** Transactions whose delete has not started. Only these can still be undone. */
  pendingIds: ReadonlySet<string>;
  /** Hides the transaction now and deletes it after UNDO_DELAY_MS. */
  requestDelete(id: string): void;
  /** Cancels the most recent pending delete. Returns false when no delete was pending. */
  undo(): boolean;
}

const UndoContext = createContext<UndoApi | null>(null);

export function UndoProvider({ db, children }: { db: Pick<SqlRunner, "execute">; children: ReactNode }) {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // Map keeps insertion order, so the last key is the most recent request.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Copies the timer keys, so the UI knows which deletes it can still undo.
  const syncPending = useCallback(() => setPendingIds(new Set(timers.current.keys())), []);

  const show = useCallback((id: string) => {
    setHiddenIds((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);

  // The id stays hidden after a successful delete, so the row does not come
  // back for a moment before the live queries update.
  const runDelete = useCallback(
    (id: string) => {
      const timer = timers.current.get(id);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.current.delete(id);
      syncPending();
      db.execute("DELETE FROM transactions WHERE id = ?", [id]).catch((error: unknown) => {
        console.warn("delete failed", error);
        show(id);
      });
    },
    [db, show, syncPending],
  );

  const requestDelete = useCallback(
    (id: string) => {
      if (timers.current.has(id)) return;
      setHiddenIds((previous) => new Set(previous).add(id));
      timers.current.set(
        id,
        setTimeout(() => runDelete(id), UNDO_DELAY_MS),
      );
      syncPending();
    },
    [runDelete, syncPending],
  );

  const undo = useCallback(() => {
    const id = [...timers.current.keys()].pop();
    if (id === undefined) return false;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    syncPending();
    show(id);
    return true;
  }, [show, syncPending]);

  // iOS can end the app from the inactive state without a background event,
  // so every state other than active runs the pending deletes.
  // On the web a reload or a closed tab does not unmount the provider, and async
  // work after unload is not guaranteed. So the deletes start as soon as the page
  // is hidden (visibilitychange comes before pagehide), and again on pagehide.
  useEffect(() => {
    const runAll = () => [...timers.current.keys()].forEach(runDelete);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") runAll();
    });
    const page = pageEvents();
    const onVisibility = () => {
      if (page?.document.visibilityState === "hidden") runAll();
    };
    page?.document.addEventListener("visibilitychange", onVisibility);
    page?.window.addEventListener("pagehide", runAll);
    return () => {
      subscription.remove();
      page?.document.removeEventListener("visibilitychange", onVisibility);
      page?.window.removeEventListener("pagehide", runAll);
      runAll();
    };
  }, [runDelete]);

  const value = useMemo(
    () => ({ hiddenIds, pendingIds, requestDelete, undo }),
    [hiddenIds, pendingIds, requestDelete, undo],
  );
  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

// The browser window and document, or null on iOS and Android.
function pageEvents(): { window: Window; document: Document } | null {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return null;
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return null;
  return { window, document };
}

export function useUndo(): UndoApi {
  const api = useContext(UndoContext);
  if (!api) throw new Error("useUndo needs an UndoProvider");
  return api;
}
