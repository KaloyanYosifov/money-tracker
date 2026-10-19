import type { Category, UserSettings } from "../generated/schema";
import { newId } from "../domain/ids";
import {
  validateAccount,
  validateCategory,
  validateRecurringRule,
  validateTransaction,
  type AccountInput,
  type CategoryInput,
  type FieldError,
  type RecurringRuleInput,
  type TransactionInput,
} from "../domain/validation";
import { generateDue } from "./recurringGenerator";

export type { AccountInput, CategoryInput, FieldError, RecurringRuleInput, TransactionInput };

// The part of the PowerSync database that the mutations use. The test helper
// implements it over better-sqlite3.
export interface SqlRunner {
  execute(sql: string, parameters?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
  getOptional<T>(sql: string, parameters?: unknown[]): Promise<T | null>;
}

export interface MutationDb extends SqlRunner {
  writeTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export type SaveResult = { ok: true; id: string } | { ok: false; errors: FieldError[] };

type Value = string | number | null;
type Row = Record<string, Value>;

function fail(errors: FieldError[]): SaveResult {
  return { ok: false, errors };
}

type UserSettingsRow = Row & { id: string; user_id: string; currency_code: string };

async function currentSettings(tx: SqlRunner): Promise<UserSettingsRow> {
  const settings = await tx.getOptional<UserSettingsRow>("SELECT * FROM user_settings LIMIT 1");
  if (!settings) throw new Error("user_settings is not synced yet");
  return settings;
}

// Inserts a new row, or updates only the columns that differ from the stored
// row. PowerSync then uploads a PATCH with only those fields. `table` comes
// only from this file, and the column names only from the typed inputs.
async function write(
  tx: SqlRunner,
  table: string,
  id: string | undefined,
  values: Row,
  insertOnly: () => Promise<Row>,
): Promise<string> {
  const existing = id ? await tx.getOptional<Row>(`SELECT * FROM ${table} WHERE id = ?`, [id]) : null;
  if (existing && id) {
    await updateChanged(tx, table, id, existing, values);
    return id;
  }
  const row: Row = { id: id ?? newId(), ...values, ...(await insertOnly()) };
  const columns = Object.keys(row);
  await tx.execute(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
  return row.id as string;
}

async function updateChanged(tx: SqlRunner, table: string, id: string, existing: Row, values: Row) {
  const changed = Object.keys(values).filter((column) => values[column] !== existing[column]);
  if (changed.length === 0) return;
  await tx.execute(`UPDATE ${table} SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [
    ...changed.map((c) => values[c]),
    id,
  ]);
}

async function categoryType(tx: SqlRunner, categoryId: string | null | undefined) {
  if (!categoryId) return null;
  const row = await tx.getOptional<{ type: Category["type"] }>("SELECT type FROM categories WHERE id = ?", [categoryId]);
  return row?.type ?? null;
}

// The API rejects a reference to an account that does not exist. Fields that
// already have an error are not checked again.
async function checkAccounts(tx: SqlRunner, input: Omit<TransactionInput, "date">, errors: FieldError[]) {
  for (const field of ["account_id", "to_account_id"] as const) {
    const accountId = input[field];
    if (!accountId || errors.some((e) => e.field === field)) continue;
    const found = await tx.getOptional("SELECT id FROM accounts WHERE id = ?", [accountId]);
    if (!found) errors.push({ field, code: "invalid_reference" });
  }
}

function moneyValues(input: Omit<TransactionInput, "date" | "id">): Row {
  return {
    type: input.type,
    amount_minor: input.amount_minor,
    name: input.name,
    category_id: input.category_id ?? null,
    account_id: input.account_id,
    to_account_id: input.to_account_id ?? null,
    note: input.note ?? null,
  };
}

/** Inserts a manual transaction, or updates the changed columns when input.id exists. */
export function saveTransaction(db: MutationDb, input: TransactionInput): Promise<SaveResult> {
  return db.writeTransaction(async (tx) => {
    const errors = validateTransaction(input, await categoryType(tx, input.category_id));
    await checkAccounts(tx, input, errors);
    if (errors.length > 0) return fail(errors);

    const values: Row = { ...moneyValues(input), date: input.date };
    const id = await write(tx, "transactions", input.id, values, async () => {
      const settings = await currentSettings(tx);
      return { user_id: settings.user_id, currency_code: settings.currency_code, source: "manual" };
    });
    return { ok: true, id };
  });
}

/** Saves a recurring rule, then generates its due occurrences up to today. */
export async function saveRecurringRule(db: MutationDb, input: RecurringRuleInput, today: string): Promise<SaveResult> {
  const result = await db.writeTransaction(async (tx): Promise<SaveResult> => {
    const errors = validateRecurringRule(input, await categoryType(tx, input.category_id));
    await checkAccounts(tx, input, errors);
    if (errors.length > 0) return fail(errors);

    const values: Row = {
      ...moneyValues(input),
      frequency: input.frequency,
      start_date: input.start_date,
      end_date: input.end_date ?? null,
    };
    const id = await write(tx, "recurring_rules", input.id, values, async () => ({
      user_id: (await currentSettings(tx)).user_id,
    }));
    return { ok: true, id };
  });
  if (result.ok) await generateDue(db, today);
  return result;
}

// Inserts get the next sort_order after all rows of the table.
async function nextSortOrder(tx: SqlRunner, table: "categories" | "accounts"): Promise<number> {
  const row = await tx.getOptional<{ next: number }>(`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM ${table}`);
  return row?.next ?? 0;
}

export function saveCategory(db: MutationDb, input: CategoryInput): Promise<SaveResult> {
  return db.writeTransaction(async (tx) => {
    const errors = validateCategory(input);
    if (errors.length > 0) return fail(errors);

    const values: Row = { type: input.type, name: input.name, icon: input.icon, color: input.color };
    if (input.sort_order !== undefined) values.sort_order = input.sort_order;
    const id = await write(tx, "categories", input.id, values, async () => ({
      user_id: (await currentSettings(tx)).user_id,
      sort_order: input.sort_order ?? (await nextSortOrder(tx, "categories")),
    }));
    return { ok: true, id };
  });
}

export function saveAccount(db: MutationDb, input: AccountInput): Promise<SaveResult> {
  return db.writeTransaction(async (tx) => {
    const errors = validateAccount(input);
    if (errors.length > 0) return fail(errors);

    const values: Row = { name: input.name, color: input.color };
    if (input.sort_order !== undefined) values.sort_order = input.sort_order;
    const id = await write(tx, "accounts", input.id, values, async () => ({
      user_id: (await currentSettings(tx)).user_id,
      sort_order: input.sort_order ?? (await nextSortOrder(tx, "accounts")),
    }));
    return { ok: true, id };
  });
}

export async function archiveCategory(db: MutationDb, id: string): Promise<void> {
  await db.execute("UPDATE categories SET archived_at = ? WHERE id = ?", [new Date().toISOString(), id]);
}

export async function archiveAccount(db: MutationDb, id: string): Promise<void> {
  await db.execute("UPDATE accounts SET archived_at = ? WHERE id = ?", [new Date().toISOString(), id]);
}

// The server refuses to delete a record that other rows still reference
// (foreign keys with ON DELETE RESTRICT), so the app refuses it first.
// usedBy is SQL with one ? parameter for each subquery. Each gets the id.
async function deleteUnused(db: MutationDb, table: string, id: string, usedBy: string[]): Promise<SaveResult> {
  return db.writeTransaction(async (tx) => {
    const used = await tx.getOptional(
      `SELECT 1 AS used WHERE ${usedBy.map((q) => `EXISTS (${q})`).join(" OR ")}`,
      usedBy.map(() => id),
    );
    if (used) return fail([{ field: "id", code: "in_use" }]);
    await tx.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
    return { ok: true, id };
  });
}

export function deleteCategory(db: MutationDb, id: string): Promise<SaveResult> {
  return deleteUnused(db, "categories", id, [
    "SELECT 1 FROM transactions WHERE category_id = ?",
    "SELECT 1 FROM recurring_rules WHERE category_id = ?",
    "SELECT 1 FROM budgets WHERE category_id = ?",
  ]);
}

export function deleteAccount(db: MutationDb, id: string): Promise<SaveResult> {
  return deleteUnused(db, "accounts", id, [
    "SELECT 1 FROM transactions WHERE ? IN (account_id, to_account_id)",
    "SELECT 1 FROM recurring_rules WHERE ? IN (account_id, to_account_id)",
  ]);
}

export type SettingsPatch = Partial<Omit<UserSettings, "id" | "user_id">>;

const settingsColumns: readonly string[] = [
  "currency_code",
  "time_period",
  "week_start_day",
  "month_start_day",
  "year_start_month",
  "budget_mode",
  "carry_over",
  "hide_future",
  "show_note",
  "theme",
  "summary_font",
  "icon_style",
];

/** Updates the changed columns of the one user_settings row. Booleans are stored as 0 or 1. */
export function updateSettings(db: MutationDb, patch: SettingsPatch): Promise<void> {
  return db.writeTransaction(async (tx) => {
    const settings = await currentSettings(tx);
    const values: Row = {};
    for (const [column, value] of Object.entries(patch)) {
      if (!settingsColumns.includes(column)) throw new Error(`unknown setting ${column}`);
      if (value === undefined) continue;
      values[column] = typeof value === "boolean" ? (value ? 1 : 0) : value;
    }
    await updateChanged(tx, "user_settings", settings.id, settings, values);
  });
}
