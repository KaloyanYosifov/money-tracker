import { useQuery } from "@powersync/react";

import type { Transaction } from "../generated/schema";
import { useUndo } from "./UndoProvider";
import { shiftPeriod, today as localToday, type Period, type PeriodKind, type PeriodSettings } from "../domain/period";

// Each query is SQL plus its parameters. The SQL is built only from the fixed
// fragments in this file. All values go in as parameters.
export interface SqlQuery {
  sql: string;
  parameters: (string | number | null)[];
}

type TransactionType = Transaction["type"];

// Rows after today are hidden when user_settings.hide_future is on.
// Takes one parameter: today.
const visible = "(t.date <= ? OR NOT EXISTS (SELECT 1 FROM user_settings WHERE hide_future = 1))";

export interface PeriodTotals {
  income: number;
  expense: number;
  transfer_in: number;
  transfer_out: number;
  balance: number;
}

export interface TotalsFilters {
  categoryId?: string | null;
  type?: TransactionType | null;
  search?: string;
  /** Rows to leave out, for example the pending deletes that the lists hide. */
  excludeIds?: readonly string[];
}

// Leaves out the rows with the ids in a JSON array. Takes one parameter.
const notExcluded = "t.id NOT IN (SELECT value FROM json_each(?))";

/**
 * Totals for one account, or for all accounts when accountId is null.
 * Transfers count only for one account, as transfer_in and transfer_out.
 * The category, type and search filters work as in transactionList.
 */
export function periodTotals(range: Period, accountId: string | null, today: string, filters: TotalsFilters = {}): SqlQuery {
  const list = listFilters(filters);
  return {
    sql: `SELECT income, expense, transfer_in, transfer_out,
        income - expense + transfer_in - transfer_out AS balance
      FROM (
        SELECT
          COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_minor END), 0) AS income,
          COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_minor END), 0) AS expense,
          COALESCE(SUM(CASE WHEN t.type = 'transfer' AND t.to_account_id = ? THEN t.amount_minor END), 0) AS transfer_in,
          COALESCE(SUM(CASE WHEN t.type = 'transfer' AND t.account_id = ? THEN t.amount_minor END), 0) AS transfer_out
        FROM transactions t
        WHERE t.date BETWEEN ? AND ? AND ${visible}
          AND (? IS NULL OR t.account_id = ? OR t.to_account_id = ?)
          AND ${list.sql}
          AND ${notExcluded}
      )`,
    parameters: [
      accountId,
      accountId,
      range.start,
      range.end,
      today,
      accountId,
      accountId,
      accountId,
      ...list.parameters,
      JSON.stringify(filters.excludeIds ?? []),
    ],
  };
}

export interface CategoryTotal {
  category_id: string;
  name: string;
  icon: string;
  color: string;
  archived_at: string | null;
  total: number;
}

/** Totals per category, largest first. Archived categories keep their name. */
export function categoryTotals(
  range: Period,
  accountId: string | null,
  type: "expense" | "income",
  today: string,
  excludeIds: readonly string[] = [],
): SqlQuery {
  return {
    sql: `SELECT c.id AS category_id, c.name, c.icon, c.color, c.archived_at, SUM(t.amount_minor) AS total
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
      WHERE t.type = ? AND t.date BETWEEN ? AND ? AND ${visible}
        AND (? IS NULL OR t.account_id = ?)
        AND ${notExcluded}
      GROUP BY c.id
      ORDER BY total DESC, c.name COLLATE NOCASE, c.id`,
    parameters: [type, range.start, range.end, today, accountId, accountId, JSON.stringify(excludeIds)],
  };
}

// Balance per account from the opening balance and all rows before a date:
// income minus expense plus transfers in minus transfers out. An account with
// exclude_from_carry_over has no balance: its rows count only in their period.
// Takes the parameters before, today, before, today.
const balancesCte = `balances AS (
    SELECT account_id, SUM(delta) AS balance FROM (
      SELECT t.account_id, CASE WHEN t.type = 'income' THEN t.amount_minor ELSE -t.amount_minor END AS delta
        FROM transactions t WHERE t.date < ? AND ${visible}
      UNION ALL
      SELECT t.to_account_id, t.amount_minor
        FROM transactions t WHERE t.type = 'transfer' AND t.date < ? AND ${visible}
      UNION ALL
      SELECT a.id, a.opening_balance_minor
        FROM accounts a WHERE a.opening_balance_minor <> 0
    )
    WHERE account_id NOT IN (SELECT id FROM accounts WHERE exclude_from_carry_over = 1)
    GROUP BY account_id
  )`;

export interface CarryOver {
  account_id: string;
  account_name: string;
  balance: number;
}

/**
 * One balance per account from all rows before `start`, also when it is zero.
 * Archived accounts are included, so their money stays in All Accounts.
 * accountIds null means all accounts.
 */
export function carryOver(start: string, accountIds: string[] | null, today: string): SqlQuery {
  const ids = accountIds === null ? null : JSON.stringify(accountIds);
  return {
    sql: `WITH ${balancesCte}
      SELECT a.id AS account_id, a.name AS account_name, COALESCE(b.balance, 0) AS balance
      FROM accounts a
      LEFT JOIN balances b ON b.account_id = a.id
      WHERE (? IS NULL OR a.id IN (SELECT value FROM json_each(?)))
      ORDER BY a.sort_order, a.name COLLATE NOCASE, a.id`,
    parameters: [start, today, start, today, ids, ids],
  };
}

export interface TransactionFilters {
  accountId?: string | null;
  categoryId?: string | null;
  type?: TransactionType | null;
}

export type TransactionSort = "date" | "name" | "amount";

export interface TransactionListRow {
  id: string;
  kind: "transaction" | "carryOver";
  type: TransactionType;
  amount_minor: number;
  currency_code: string;
  date: string;
  name: string;
  note: string | null;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
  account_id: string;
  account_name: string | null;
  to_account_id: string | null;
  to_account_name: string | null;
  recurring_rule_id: string | null;
}

// kind_rank is 0 for transactions and 1 for Carry Over rows. In the name and
// amount sorts the Carry Over rows come first.
const orderBy: Record<TransactionSort, string> = {
  date: "date DESC, kind_rank, name COLLATE NOCASE, id",
  name: "kind_rank DESC, name COLLATE NOCASE, date DESC, id",
  amount: "kind_rank DESC, amount_minor DESC, date DESC, id",
};

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * SQLite LIKE folds the case of ASCII letters only. For other scripts (for
 * example Cyrillic) the search also tries the lower, upper, first-letter and
 * title case forms of the term.
 */
function likePatterns(search: string): string[] {
  const lower = search.toLocaleLowerCase();
  const capitalize = (word: string) => word.charAt(0).toLocaleUpperCase() + word.slice(1);
  const forms = [search, lower, search.toLocaleUpperCase(), capitalize(lower), lower.split(" ").map(capitalize).join(" ")];
  return [...new Set(forms)].map(likePattern);
}

// The category, type and search conditions on the transactions t.
function listFilters(filters: TotalsFilters): SqlQuery {
  const categoryId = filters.categoryId ?? null;
  const type = filters.type ?? null;
  const term = (filters.search ?? "").trim();
  return {
    sql: `(? IS NULL OR t.category_id = ?)
        AND (? IS NULL OR t.type = ?)
        AND (? = '' OR EXISTS (SELECT 1 FROM json_each(?) p
          WHERE t.name LIKE p.value ESCAPE '\\' OR t.note LIKE p.value ESCAPE '\\'))`,
    parameters: [categoryId, categoryId, type, type, term, JSON.stringify(likePatterns(term))],
  };
}

/**
 * The rows of one period. When carry_over is on and no category, type or search
 * filter is set, the list also has one virtual Carry Over row per account
 * (archived accounts too, as in carryOver) with a balance that is not zero,
 * dated range.start.
 * A limit of -1 returns all rows.
 */
export function transactionList(
  range: Period,
  filters: TransactionFilters,
  sort: TransactionSort,
  search: string,
  today: string,
  page: { limit: number; offset: number } = { limit: -1, offset: 0 },
): SqlQuery {
  const accountId = filters.accountId ?? null;
  const categoryId = filters.categoryId ?? null;
  const type = filters.type ?? null;
  const term = search.trim();
  const list = listFilters({ categoryId, type, search });
  return {
    sql: `WITH ${balancesCte}
      SELECT * FROM (
      SELECT t.id, 'transaction' AS kind, 0 AS kind_rank, t.type, t.amount_minor, t.currency_code, t.date,
        t.name, t.note, t.category_id, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
        t.account_id, a.name AS account_name, t.to_account_id, ta.name AS to_account_name, t.recurring_rule_id
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts ta ON ta.id = t.to_account_id
      WHERE t.date BETWEEN ? AND ? AND ${visible}
        AND (? IS NULL OR t.account_id = ? OR t.to_account_id = ?)
        AND ${list.sql}
      UNION ALL
      SELECT 'carryOver:' || a.id, 'carryOver', 1, CASE WHEN b.balance < 0 THEN 'expense' ELSE 'income' END,
        ABS(b.balance), (SELECT currency_code FROM user_settings LIMIT 1), ?,
        'Carry Over', NULL, NULL, NULL, NULL, NULL,
        a.id, a.name, NULL, NULL, NULL
      FROM accounts a
      JOIN balances b ON b.account_id = a.id
      WHERE b.balance <> 0
        AND EXISTS (SELECT 1 FROM user_settings WHERE carry_over = 1)
        AND (? IS NULL OR a.id = ?)
        AND ? IS NULL AND ? IS NULL AND ? = ''
      )
      ORDER BY ${orderBy[sort]}
      LIMIT ? OFFSET ?`,
    parameters: [
      range.start, today, range.start, today,
      range.start, range.end, today,
      accountId, accountId, accountId,
      ...list.parameters,
      range.start,
      accountId, accountId,
      categoryId, type, term,
      page.limit, page.offset,
    ],
  };
}

export interface BudgetProgress {
  budget_id: string;
  period: string;
  amount_minor: number;
  spent_minor: number;
}

/**
 * The overall budget for the time_period setting and the expenses in the range.
 * No row when budget_mode is off or no such budget exists.
 */
export function budgetProgress(range: Period, today: string): SqlQuery {
  return {
    sql: `SELECT b.id AS budget_id, b.period, b.amount_minor,
        (SELECT COALESCE(SUM(t.amount_minor), 0) FROM transactions t
          WHERE t.type = 'expense' AND t.date BETWEEN ? AND ? AND ${visible}) AS spent_minor
      FROM budgets b
      JOIN user_settings s ON s.time_period = b.period
      WHERE s.budget_mode = 1 AND b.category_id IS NULL
      ORDER BY b.id
      LIMIT 1`,
    parameters: [range.start, range.end, today],
  };
}

export interface CashFlowPoint {
  start: string;
  end: string;
  income: number;
  expense: number;
}

/** Income and expense of all accounts for the `count` periods that end with endRange, oldest first. */
export function cashFlowSeries(
  endRange: Period,
  kind: PeriodKind,
  settings: PeriodSettings,
  count: number,
  today: string,
): SqlQuery {
  const periods: Period[] = [];
  for (let i = count - 1; i >= 0; i--) periods.push(shiftPeriod(endRange, kind, settings, -i));
  return {
    sql: `WITH periods AS (
        SELECT p.key AS idx, json_extract(p.value, '$.start') AS p_start, json_extract(p.value, '$.end') AS p_end
        FROM json_each(?) p
      )
      SELECT p_start AS start, p_end AS "end",
        (SELECT COALESCE(SUM(t.amount_minor), 0) FROM transactions t
          WHERE t.type = 'income' AND t.date BETWEEN p_start AND p_end AND ${visible}) AS income,
        (SELECT COALESCE(SUM(t.amount_minor), 0) FROM transactions t
          WHERE t.type = 'expense' AND t.date BETWEEN p_start AND p_end AND ${visible}) AS expense
      FROM periods
      ORDER BY idx`,
    parameters: [JSON.stringify(periods), today, today],
  };
}

// React hooks. useQuery watches the tables in the SQL, so the screens update
// on every local change. today() is read on each render.

function useRows<T>(query: SqlQuery) {
  return useQuery<T>(query.sql, query.parameters);
}

function useFirstRow<T>(query: SqlQuery) {
  const result = useRows<T>(query);
  return { ...result, data: result.data[0] ?? null };
}

export function usePeriodTotals(range: Period, accountId: string | null, filters?: TotalsFilters) {
  return useFirstRow<PeriodTotals>(periodTotals(range, accountId, localToday(), filters));
}

export function useCategoryTotals(range: Period, accountId: string | null, type: "expense" | "income") {
  return useRows<CategoryTotal>(categoryTotals(range, accountId, type, localToday()));
}

// The Spending chalkboard and the transaction list use these two, so both leave out
// the pending deletes (Undo) and show the same totals. They need an UndoProvider.

export function useShownPeriodTotals(range: Period, accountId: string | null, filters: TotalsFilters = {}) {
  const { hiddenIds } = useUndo();
  return usePeriodTotals(range, accountId, { ...filters, excludeIds: [...hiddenIds] });
}

export function useShownCategoryTotals(range: Period, accountId: string | null, type: "expense" | "income") {
  const { hiddenIds } = useUndo();
  return useRows<CategoryTotal>(categoryTotals(range, accountId, type, localToday(), [...hiddenIds]));
}

export function useCarryOver(start: string, accountIds: string[] | null) {
  return useRows<CarryOver>(carryOver(start, accountIds, localToday()));
}

export function useTransactionList(
  range: Period,
  filters: TransactionFilters,
  sort: TransactionSort,
  search: string,
  page?: { limit: number; offset: number },
) {
  return useRows<TransactionListRow>(transactionList(range, filters, sort, search, localToday(), page));
}

export function useBudgetProgress(range: Period) {
  return useFirstRow<BudgetProgress>(budgetProgress(range, localToday()));
}

export function useCashFlowSeries(endRange: Period, kind: PeriodKind, settings: PeriodSettings, count: number) {
  return useRows<CashFlowPoint>(cashFlowSeries(endRange, kind, settings, count, localToday()));
}
