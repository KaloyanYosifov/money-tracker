import { psql } from "./stack.ts";

/** The tables that sync and carry a user_id. */
export const SYNCED_TABLES = [
  "accounts",
  "categories",
  "transactions",
  "recurring_rules",
  "budgets",
  "user_settings",
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

/** Runs a read-only SQL query. Use psql variables (:'name') for values. */
export function query(sql: string, vars: Record<string, string> = {}): string[][] {
  return psql(sql, { vars, readOnly: true });
}

/** The number of rows in one table for one user. */
export function countRows(table: SyncedTable, userId: string): number {
  const rows = query(`SELECT count(*) FROM ${table} WHERE user_id = :'user_id';`, { user_id: userId });
  return Number(rows[0][0]);
}

/** The number of rows per synced table for one user. */
export function rowCounts(userId: string): Record<SyncedTable, number> {
  const counts = {} as Record<SyncedTable, number>;
  for (const table of SYNCED_TABLES) counts[table] = countRows(table, userId);
  return counts;
}

/** The user ID for an email, or null if the user does not exist. */
export function userIdByEmail(email: string): string | null {
  const rows = query("SELECT id FROM users WHERE email = :'email';", { email });
  return rows[0]?.[0] ?? null;
}
