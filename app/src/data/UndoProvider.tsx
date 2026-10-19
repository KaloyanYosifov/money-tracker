import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import type { SqlRunner } from "./mutations";

export const UNDO_DELAY_MS = 5000;

export interface UndoApi {
  /** Transactions that wait for their delete. Lists do not render them. */
  hiddenIds: ReadonlySet<string>;
  /** Hides the transaction now and deletes it after UNDO_DELAY_MS. */
  requestDelete(id: string): void;
  /** Cancels the most recent pending delete. */
  undo(): void;
}

const UndoContext = createContext<UndoApi | null>(null);

export function UndoProvider({ db, children }: { db: Pick<SqlRunner, "execute">; children: ReactNode }) {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  // Map keeps insertion order, so the last key is the most recent request.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

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
      db.execute("DELETE FROM transactions WHERE id = ?", [id]).catch((error: unknown) => {
        console.warn("delete failed", error);
        show(id);
      });
    },
    [db, show],
  );

  const requestDelete = useCallback(
    (id: string) => {
      if (timers.current.has(id)) return;
      setHiddenIds((previous) => new Set(previous).add(id));
      timers.current.set(
        id,
        setTimeout(() => runDelete(id), UNDO_DELAY_MS),
      );
    },
    [runDelete],
  );

  const undo = useCallback(() => {
    const id = [...timers.current.keys()].pop();
    if (id === undefined) return;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    show(id);
  }, [show]);

  // iOS can end the app from the inactive state without a background event,
  // so every state other than active runs the pending deletes.
  useEffect(() => {
    const runAll = () => [...timers.current.keys()].forEach(runDelete);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") runAll();
    });
    return () => {
      subscription.remove();
      runAll();
    };
  }, [runDelete]);

  const value = useMemo(() => ({ hiddenIds, requestDelete, undo }), [hiddenIds, requestDelete, undo]);
  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

export function useUndo(): UndoApi {
  const api = useContext(UndoContext);
  if (!api) throw new Error("useUndo needs an UndoProvider");
  return api;
}
