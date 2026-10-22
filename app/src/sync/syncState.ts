import type { SyncStatus } from "@powersync/common";
import { useQuery, useStatus } from "@powersync/react";

import { useAuth, type AuthStatus } from "../auth/AuthProvider";

export type SyncStateKind = "synced" | "syncing" | "offline" | "needsAttention" | "reauthRequired" | "updateRequired";

export interface SyncState {
  kind: SyncStateKind;
  label: string;
}

export interface SyncStateInput {
  status: Pick<SyncStatus, "connected" | "uploading" | "downloading" | "lastSyncedAt">;
  pendingCount: number;
  problemCount: number;
  auth: AuthStatus;
  updateRequired: boolean;
  now?: Date;
}

function ago(then: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function deriveSyncState(input: SyncStateInput): SyncState {
  const { status, pendingCount, problemCount } = input;
  const pending = `${pendingCount} pending`;

  if (input.updateRequired) return { kind: "updateRequired", label: "Update required" };
  if (input.auth === "reauthRequired") return { kind: "reauthRequired", label: "Log in again" };
  if (problemCount > 0) {
    return { kind: "needsAttention", label: `Needs attention · ${problemCount} ${problemCount === 1 ? "problem" : "problems"}` };
  }
  if (!status.connected) return { kind: "offline", label: `Offline · ${pending}` };
  if (status.uploading || status.downloading) return { kind: "syncing", label: `Syncing · ${pending}` };
  const synced = status.lastSyncedAt ? `Synced ${ago(status.lastSyncedAt, input.now ?? new Date())}` : "Not synced yet";
  return { kind: "synced", label: `${synced} · ${pending}` };
}

/** Sync state for the UI. ps_crud is the PowerSync upload queue. */
export function useSyncState(updateRequired = false): SyncState {
  const status = useStatus();
  const { status: auth } = useAuth();
  const pending = useQuery<{ n: number }>("SELECT count(*) AS n FROM ps_crud");
  const problems = useQuery<{ n: number }>("SELECT count(DISTINCT table_name || ':' || record_id) AS n FROM sync_problems");
  return deriveSyncState({
    status,
    pendingCount: pending.data[0]?.n ?? 0,
    problemCount: problems.data[0]?.n ?? 0,
    auth,
    updateRequired,
  });
}
