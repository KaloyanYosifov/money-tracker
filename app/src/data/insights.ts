import { useQuery } from "@powersync/react";

import type { Category, Insight, InsightQuestion, RecurringRule, UserSettings } from "../generated/schema";
import { newId } from "../domain/ids";
import { writeCategoryBudget, writeRecurringRule, type FieldError, type MutationDb, type RecurringRuleInput, type SaveResult, type SqlRunner } from "./mutations";
import { generateDue } from "./recurringGenerator";

// The local rows. SQLite keeps action as the JSON text of the suggested record.
export type InsightCard = Omit<Insight, "action"> & { action: string | null };
export type InsightQuestionRow = Omit<InsightQuestion, "action"> & { action: string | null };

/** The suggested category budget of a budget card. The period is the user's time period. */
export interface BudgetAction {
  category_id: string;
  amount_minor: number;
}

/** The suggested recurring rule of a recurring_rule card. */
export interface RecurringAction {
  type: Exclude<RecurringRule["type"], "transfer">;
  category_id: string;
  account_id?: string | null;
  amount_minor: number;
  frequency: RecurringRule["frequency"];
  start_date: string;
  end_date?: string | null;
  name: string;
  note?: string | null;
}

/** An accept that the local data no longer allows. The card is dismissed. */
export type AcceptResult = SaveResult | { ok: false; outOfDate: true };

export const MAX_QUESTION_LENGTH = 500;
/** The API worker answers at most this many questions of a user in 24 hours. */
export const DAILY_QUESTION_LIMIT = 50;

// Hooks. useQuery watches the tables in the SQL, so the screen updates on each change.

/** The open cards, newest first. */
export function useOpenCards() {
  return useQuery<InsightCard>("SELECT * FROM insights WHERE status = 'open' ORDER BY created_at DESC, id");
}

/** The time of the newest card, or null before the first run. */
export function useLastRunTime(): string | null {
  const result = useQuery<{ last: string | null }>("SELECT MAX(created_at) AS last FROM insights");
  return result.data[0]?.last ?? null;
}

/**
 * The questions about one category, or about all categories for null, newest
 * first. A question that is not synced yet has no created_at and comes first.
 */
export function useQuestions(categoryId: string | null) {
  return useQuery<InsightQuestionRow>(
    `SELECT * FROM insight_questions WHERE (? IS NULL OR category_id = ?)
     ORDER BY created_at IS NULL DESC, created_at DESC, id`,
    [categoryId, categoryId],
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isBudgetAction(value: Record<string, unknown>): boolean {
  return isText(value.category_id) && Number.isInteger(value.amount_minor);
}

function isRecurringAction(value: Record<string, unknown>): boolean {
  return (
    isBudgetAction(value) &&
    (value.type === "expense" || value.type === "income") &&
    isText(value.frequency) &&
    isText(value.start_date) &&
    typeof value.name === "string"
  );
}

/** Reads the JSON action of a card. Null for a tip, bad JSON, or a shape that does not match the kind. */
export function parseAction(card: Pick<InsightCard, "kind" | "action">): BudgetAction | RecurringAction | null {
  if (card.kind === "tip" || !card.action) return null;
  let value: unknown;
  try {
    value = JSON.parse(card.action);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (card.kind === "budget") return isBudgetAction(value) ? (value as unknown as BudgetAction) : null;
  return isRecurringAction(value) ? (value as unknown as RecurringAction) : null;
}

// Only the status changes, so PowerSync uploads a PATCH with only status.
async function setStatus(tx: SqlRunner, id: string, status: "accepted" | "dismissed") {
  await tx.execute("UPDATE insights SET status = ? WHERE id = ?", [status, id]);
}

async function outOfDate(tx: SqlRunner, id: string): Promise<AcceptResult> {
  await setStatus(tx, id, "dismissed");
  return { ok: false, outOfDate: true };
}

// The category of an action must exist, be active and have the expected type.
async function activeCategory(tx: SqlRunner, categoryId: string, type: Category["type"]): Promise<boolean> {
  const row = await tx.getOptional<{ type: string; archived_at: string | null }>(
    "SELECT type, archived_at FROM categories WHERE id = ?",
    [categoryId],
  );
  return row !== null && row.archived_at === null && row.type === type;
}

/**
 * Saves the category budget of a budget card for the user's time period and
 * accepts the card, in one transaction. amountMinor is the amount from the
 * accept sheet. When the category is gone, archived or not an expense
 * category, it dismisses the card and returns an out-of-date result.
 */
export function acceptBudgetCard(db: MutationDb, card: InsightCard, amountMinor?: number): Promise<AcceptResult> {
  return db.writeTransaction(async (tx): Promise<AcceptResult> => {
    const action = card.kind === "budget" ? (parseAction(card) as BudgetAction | null) : null;
    if (!action || !(await activeCategory(tx, action.category_id, "expense"))) return outOfDate(tx, card.id);

    const settings = await tx.getOptional<{ time_period: UserSettings["time_period"] }>(
      "SELECT time_period FROM user_settings LIMIT 1",
    );
    if (!settings) throw new Error("user_settings is not synced yet");
    const result = await writeCategoryBudget(tx, action.category_id, settings.time_period, amountMinor ?? action.amount_minor);
    if (result.ok) await setStatus(tx, card.id, "accepted");
    return result;
  });
}

/**
 * Saves the recurring rule of a recurring_rule card and accepts the card in
 * one transaction, then generates the due occurrences up to today. changes are
 * the values from the accept sheet. When the category is gone, archived or of
 * another type, it dismisses the card and returns an out-of-date result.
 */
export async function acceptRecurringCard(
  db: MutationDb,
  card: InsightCard,
  today: string,
  changes: Partial<Omit<RecurringRuleInput, "id">> = {},
): Promise<AcceptResult> {
  const result = await db.writeTransaction(async (tx): Promise<AcceptResult> => {
    const action = card.kind === "recurring_rule" ? (parseAction(card) as RecurringAction | null) : null;
    if (!action || !(await activeCategory(tx, action.category_id, action.type))) return outOfDate(tx, card.id);

    const input: RecurringRuleInput = {
      type: action.type,
      amount_minor: action.amount_minor,
      name: action.name,
      category_id: action.category_id,
      account_id: action.account_id ?? "",
      note: action.note ?? null,
      frequency: action.frequency,
      start_date: action.start_date,
      end_date: action.end_date ?? null,
      ...changes,
    };
    const saved = await writeRecurringRule(tx, input);
    if (saved.ok) await setStatus(tx, card.id, "accepted");
    return saved;
  });
  if (result.ok) await generateDue(db, today);
  return result;
}

export async function dismissCard(db: MutationDb, id: string): Promise<void> {
  await db.writeTransaction((tx) => setStatus(tx, id, "dismissed"));
}

/**
 * Inserts a pending question about a category. The API worker answers it
 * after the row syncs, so this works offline.
 */
export function askQuestion(db: MutationDb, categoryId: string, text: string): Promise<SaveResult> {
  return db.writeTransaction(async (tx): Promise<SaveResult> => {
    const question = text.trim();
    const errors: FieldError[] = [];
    if (question === "") errors.push({ field: "question", code: "required" });
    else if (question.length > MAX_QUESTION_LENGTH) errors.push({ field: "question", code: "too_long" });
    if (errors.length > 0) return { ok: false, errors };

    // A question that is not synced yet has no created_at, so it counts too.
    const recent = await tx.getOptional<{ count: number }>(
      `SELECT COUNT(*) AS count FROM insight_questions
       WHERE status <> 'failed' AND (created_at IS NULL OR julianday(created_at) > julianday('now', '-1 day'))`,
    );
    if ((recent?.count ?? 0) >= DAILY_QUESTION_LIMIT) {
      return {
        ok: false,
        errors: [
          {
            field: "question",
            code: "out_of_range",
            message: `You can ask ${DAILY_QUESTION_LIMIT} questions a day. Try again later.`,
          },
        ],
      };
    }

    const settings = await tx.getOptional<{ user_id: string }>("SELECT user_id FROM user_settings LIMIT 1");
    if (!settings) throw new Error("user_settings is not synced yet");
    const id = newId();
    await tx.execute(
      "INSERT INTO insight_questions (id, user_id, category_id, question, status) VALUES (?, ?, ?, ?, ?)",
      [id, settings.user_id, categoryId, question, "pending"],
    );
    return { ok: true, id };
  });
}
