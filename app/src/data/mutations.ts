import type { Category, UserSettings } from "../generated/schema";
import { newId } from "../domain/ids";
import { MAX_AMOUNT_MINOR } from "../domain/money";
import {
  DUPLICATE_ACCOUNT_MESSAGE,
  DUPLICATE_CATEGORY_MESSAGE,
  nameKey,
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

/**
 * Saves a recurring rule, then generates its due occurrences up to today. An
 * edit never changes generated_through: a new start_date or frequency applies
 * to the dates after it, so no past occurrences are filled in, and an
 * occurrence that the user deleted stays deleted.
 */
export async function saveRecurringRule(db: MutationDb, input: RecurringRuleInput, today: string): Promise<SaveResult> {
  const result = await db.writeTransaction((tx) => writeRecurringRule(tx, input));
  if (result.ok) await generateDue(db, today);
  return result;
}

/**
 * Validates and writes a recurring rule inside a caller's transaction, so the
 * AI Insights accept flow can save a rule and a card status together. The
 * caller runs generateDue after the transaction.
 */
export async function writeRecurringRule(tx: SqlRunner, input: RecurringRuleInput): Promise<SaveResult> {
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
}

// Inserts get the next sort_order after all rows of the table.
async function nextSortOrder(tx: SqlRunner, table: "categories" | "accounts"): Promise<number> {
  const row = await tx.getOptional<{ next: number }>(`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM ${table}`);
  return row?.next ?? 0;
}

// A name must differ from the names of the other non-archived rows in `others`
// (case-insensitive, trimmed). The check runs only for a new row or a changed
// name or type, so an edit of other fields or a reorder still saves a row that
// has a duplicate name after a restore.
async function checkUniqueName(
  tx: SqlRunner,
  table: "categories" | "accounts",
  input: { id?: string; name: string; type?: string },
  message: string,
  errors: FieldError[],
) {
  const key = nameKey(input.name);
  const typeFilter = input.type === undefined ? "" : " AND type = ?";
  const typeParameter = input.type === undefined ? [] : [input.type];
  if (input.id) {
    const stored = await tx.getOptional<{ name: string; type?: string }>(`SELECT * FROM ${table} WHERE id = ?`, [input.id]);
    if (stored && nameKey(stored.name) === key && stored.type === input.type) return;
  }
  const others = await tx.getAll<{ name: string }>(
    `SELECT name FROM ${table} WHERE archived_at IS NULL AND id <> ?${typeFilter}`,
    [input.id ?? "", ...typeParameter],
  );
  if (others.some((row) => nameKey(row.name) === key)) errors.push({ field: "name", code: "invalid", message });
}

export function saveCategory(db: MutationDb, input: CategoryInput): Promise<SaveResult> {
  return db.writeTransaction(async (tx) => {
    const errors = validateCategory(input);
    if (errors.length === 0) await checkUniqueName(tx, "categories", input, DUPLICATE_CATEGORY_MESSAGE, errors);
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
    if (errors.length === 0) {
      await checkUniqueName(tx, "accounts", { id: input.id, name: input.name }, DUPLICATE_ACCOUNT_MESSAGE, errors);
    }
    if (errors.length > 0) return fail(errors);

    const values: Row = { name: input.name, color: input.color };
    if (input.sort_order !== undefined) values.sort_order = input.sort_order;
    if (input.opening_balance_minor !== undefined && input.opening_balance_minor !== null) values.opening_balance_minor = input.opening_balance_minor;
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

export async function restoreCategory(db: MutationDb, id: string): Promise<void> {
  await db.execute("UPDATE categories SET archived_at = NULL WHERE id = ?", [id]);
}

export async function restoreAccount(db: MutationDb, id: string): Promise<void> {
  await db.execute("UPDATE accounts SET archived_at = NULL WHERE id = ?", [id]);
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
  "insights_enabled",
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

/** Inserts or updates the overall budget (no category) for one period kind. */
export function saveOverallBudget(db: MutationDb, period: UserSettings["time_period"], amountMinor: number): Promise<SaveResult> {
  return db.writeTransaction(async (tx) => {
    if (!Number.isInteger(amountMinor) || amountMinor < 1 || amountMinor > MAX_AMOUNT_MINOR) {
      return fail([{ field: "amount_minor", code: "out_of_range" }]);
    }
    const existing = await tx.getOptional<{ id: string }>(
      "SELECT id FROM budgets WHERE category_id IS NULL AND period = ? ORDER BY id LIMIT 1",
      [period],
    );
    const id = await write(tx, "budgets", existing?.id, { amount_minor: amountMinor }, async () => {
      const settings = await currentSettings(tx);
      return { user_id: settings.user_id, category_id: null, period };
    });
    return { ok: true, id };
  });
}

/**
 * Writes or deletes the budget of one expense category for the period. A null
 * amount deletes the budget. It runs inside a caller's transaction, so the AI
 * Insights accept flow can save a budget and a card status together.
 */
export async function writeCategoryBudget(
  tx: SqlRunner,
  categoryId: string,
  period: UserSettings["time_period"],
  amountMinor: number | null,
): Promise<SaveResult> {
  const existing = await tx.getOptional<{ id: string }>(
    "SELECT id FROM budgets WHERE category_id = ? AND period = ? ORDER BY id LIMIT 1",
    [categoryId, period],
  );
  // A null amount deletes the budget. A delete must work for any category type,
  // so switching a category to income can clear the budget it had.
  if (amountMinor === null) {
    if (!existing) return { ok: true, id: "" };
    await tx.execute("DELETE FROM budgets WHERE id = ?", [existing.id]);
    return { ok: true, id: existing.id };
  }
  const category = await tx.getOptional<{ type: string }>("SELECT type FROM categories WHERE id = ?", [categoryId]);
  if (!category || category.type !== "expense") return fail([{ field: "category_id", code: "invalid" }]);
  if (!Number.isInteger(amountMinor) || amountMinor < 1 || amountMinor > MAX_AMOUNT_MINOR) {
    return fail([{ field: "amount_minor", code: "out_of_range" }]);
  }
  const id = await write(tx, "budgets", existing?.id, { amount_minor: amountMinor }, async () => {
    const settings = await currentSettings(tx);
    return { user_id: settings.user_id, category_id: categoryId, period };
  });
  return { ok: true, id };
}

/** Inserts, updates or deletes the budget of one expense category for the period. */
export function saveCategoryBudget(
  db: MutationDb,
  categoryId: string,
  period: UserSettings["time_period"],
  amountMinor: number | null,
): Promise<SaveResult> {
  return db.writeTransaction((tx) => writeCategoryBudget(tx, categoryId, period, amountMinor));
}
