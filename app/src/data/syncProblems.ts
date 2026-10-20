import { useQuery } from "@powersync/react";

import type { SqlRunner } from "./mutations";

/** A row of the local-only sync_problems table: an upload that the API rejected. */
export interface SyncProblem {
  id: string;
  table_name: string;
  record_id: string;
  op: "PUT" | "PATCH" | "DELETE";
  /** The uploaded fields as JSON. Null for DELETE. */
  data_json: string | null;
  code: string;
  message: string;
  created_at: string;
}

/** The tables that have a form for "Edit and retry". */
export const EDITABLE_TABLES: readonly string[] = ["transactions", "categories", "accounts"];

/**
 * The record for the form: the local row with the rejected fields on top. A
 * PATCH needs the local row, because it holds only the changed fields.
 */
export function problemRecord<T>(problem: SyncProblem | undefined, row: T | undefined): T | undefined {
  if (!problem || problem.op === "DELETE") return row;
  if (!row && problem.op !== "PUT") return undefined;
  const data = problem.data_json ? (JSON.parse(problem.data_json) as Partial<T>) : {};
  return { ...row, ...data, id: problem.record_id } as T;
}

export async function deleteSyncProblem(db: SqlRunner, id: string): Promise<void> {
  await db.execute("DELETE FROM sync_problems WHERE id = ?", [id]);
}

/** The problem that a form edits, if any. */
export function useSyncProblem(problemId: string | undefined): { problem: SyncProblem | undefined; isLoading: boolean } {
  const { data, isLoading } = useQuery<SyncProblem>("SELECT * FROM sync_problems WHERE id = ?", [problemId ?? ""]);
  return { problem: problemId ? data[0] : undefined, isLoading };
}
