import type { Category, RecurringRule, Transaction } from "../generated/schema";
import { MAX_AMOUNT_MINOR } from "./money";

// The same rules as the JSON Schemas and the API apply rules. Mutations and
// forms both use these functions, so a record that passes here is not
// rejected by the server.

export type ValidationCode =
  | "required"
  | "invalid"
  | "too_long"
  | "out_of_range"
  | "invalid_category_type"
  | "invalid_transfer"
  | "invalid_reference"
  | "in_use";

export interface FieldError {
  field: string;
  code: ValidationCode;
  /** Text for the user, for errors that the code alone does not explain (for example a duplicate name). */
  message?: string;
}

export const DUPLICATE_CATEGORY_MESSAGE = "A category with this name exists.";
export const DUPLICATE_ACCOUNT_MESSAGE = "An account with this name exists.";

/** The form of a name that duplicate checks compare: trimmed, lower case in any script. */
export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

type CategoryType = Category["type"];

export interface TransactionInput {
  id?: string;
  type: Transaction["type"];
  amount_minor: number;
  date: string;
  name: string;
  category_id?: string | null;
  account_id: string;
  to_account_id?: string | null;
  note?: string | null;
}

export interface RecurringRuleInput extends Omit<TransactionInput, "date"> {
  frequency: RecurringRule["frequency"];
  start_date: string;
  end_date?: string | null;
}

export interface CategoryInput {
  id?: string;
  type: CategoryType;
  name: string;
  icon: string;
  color: string;
  sort_order?: number;
}

export interface AccountInput {
  id?: string;
  name: string;
  color: string;
  sort_order?: number;
  opening_balance_minor?: number | null;
}

const transactionTypes: readonly string[] = ["expense", "income", "transfer"];
const categoryTypes: readonly string[] = ["expense", "income"];
const frequencies: readonly string[] = ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"];

/** True for a real calendar date in the form YYYY-MM-DD. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function checkText(errors: FieldError[], field: string, value: string | null | undefined, min: number, max: number) {
  const length = value?.length ?? 0;
  if (length < min) errors.push({ field, code: "required" });
  else if (length > max) errors.push({ field, code: "too_long" });
}

function checkColor(errors: FieldError[], color: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) errors.push({ field: "color", code: "invalid" });
}

function checkSortOrder(errors: FieldError[], sortOrder: number | undefined) {
  if (sortOrder !== undefined && !(Number.isInteger(sortOrder) && sortOrder >= 0)) {
    errors.push({ field: "sort_order", code: "out_of_range" });
  }
}

// Type, amount, name, note and the transfer and category rules. categoryType
// is the type of the category with input.category_id, or null if no such
// category exists.
function checkMoney(
  errors: FieldError[],
  input: Omit<TransactionInput, "date">,
  categoryType: CategoryType | null,
) {
  if (!transactionTypes.includes(input.type)) errors.push({ field: "type", code: "invalid" });
  if (!(Number.isInteger(input.amount_minor) && input.amount_minor >= 1 && input.amount_minor <= MAX_AMOUNT_MINOR)) {
    errors.push({ field: "amount_minor", code: "out_of_range" });
  }
  checkText(errors, "name", input.name, 0, 120);
  checkText(errors, "note", input.note, 0, 2000);
  if (!input.account_id) errors.push({ field: "account_id", code: "required" });

  if (input.type === "transfer") {
    if (input.category_id) errors.push({ field: "category_id", code: "invalid_transfer" });
    if (!input.to_account_id) errors.push({ field: "to_account_id", code: "required" });
    else if (input.to_account_id === input.account_id) {
      errors.push({ field: "to_account_id", code: "invalid_transfer" });
    }
    return;
  }
  if (input.to_account_id) errors.push({ field: "to_account_id", code: "invalid" });
  if (!input.category_id) errors.push({ field: "category_id", code: "required" });
  else if (categoryType === null) errors.push({ field: "category_id", code: "invalid_reference" });
  else if (categoryType !== input.type) errors.push({ field: "category_id", code: "invalid_category_type" });
}

export function validateTransaction(input: TransactionInput, categoryType: CategoryType | null): FieldError[] {
  const errors: FieldError[] = [];
  checkMoney(errors, input, categoryType);
  if (!isDate(input.date)) errors.push({ field: "date", code: "invalid" });
  return errors;
}

export function validateRecurringRule(input: RecurringRuleInput, categoryType: CategoryType | null): FieldError[] {
  const errors: FieldError[] = [];
  checkMoney(errors, input, categoryType);
  if (!frequencies.includes(input.frequency)) errors.push({ field: "frequency", code: "invalid" });
  if (!isDate(input.start_date)) errors.push({ field: "start_date", code: "invalid" });
  if (input.end_date != null) {
    if (!isDate(input.end_date)) errors.push({ field: "end_date", code: "invalid" });
    else if (input.end_date < input.start_date) errors.push({ field: "end_date", code: "out_of_range" });
  }
  return errors;
}

export function validateCategory(input: CategoryInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!categoryTypes.includes(input.type)) errors.push({ field: "type", code: "invalid" });
  checkText(errors, "name", input.name, 1, 60);
  checkText(errors, "icon", input.icon, 1, 40);
  checkColor(errors, input.color);
  checkSortOrder(errors, input.sort_order);
  return errors;
}

export function validateAccount(input: AccountInput): FieldError[] {
  const errors: FieldError[] = [];
  checkText(errors, "name", input.name, 1, 60);
  checkColor(errors, input.color);
  checkSortOrder(errors, input.sort_order);
  const balance = input.opening_balance_minor;
  if (balance !== undefined && balance !== null) {
    if (!Number.isInteger(balance)) errors.push({ field: "opening_balance_minor", code: "invalid" });
    else if (Math.abs(balance) > MAX_AMOUNT_MINOR) errors.push({ field: "opening_balance_minor", code: "out_of_range" });
  }
  return errors;
}
