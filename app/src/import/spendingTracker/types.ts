// Rows of the Spending Tracker backup (a SQLite file), and the types of the
// import that changes them into upload ops.

export type SourceType = "Expense" | "Income" | "Transfer" | "Carry";

export interface SourceProfile {
  Id: number;
  Name: string | null;
  Colour: string | null;
}

export interface SourceCategory {
  Id: number;
  Name: string | null;
  Type: SourceType;
  Icon: string | null;
  Colour: string | null;
}

export interface SourceTransaction {
  Id: number;
  Type: "Expense" | "Income" | "Transfer";
  /** .NET ticks. */
  Date: number | bigint;
  Amount: number;
  Note: string | null;
  ProfileId: number | null;
  CategoryId: number | null;
  RecurringTransactionId: number | null;
}

export interface SourceRecurring {
  Id: number;
  Type: "Expense" | "Income" | "Transfer";
  /** Start date, .NET ticks. */
  Date: number | bigint;
  EndDate: number | bigint | null;
  Amount: number;
  Note: string | null;
  RecurringType: string;
  RecurringPeriod: number;
  ProfileId: number | null;
  CategoryId: number | null;
}

/** The settings of a profile. A row with no ProfileId is the default for all profiles. */
export interface SourceStrategy {
  ProfileId: number | null;
  /** 1: a negative balance at the end of a month is carried over as 0. */
  CarryPositiveOnly: number;
}

export interface SourceData {
  profiles: SourceProfile[];
  categories: SourceCategory[];
  transactions: SourceTransaction[];
  recurring: SourceRecurring[];
  strategies: SourceStrategy[];
}

/** The response body of GET /api/import/existing. */
export interface Existing {
  currency_code: string;
  accounts: { id: string; name: string; sort_order: number; opening_balance_minor: number; archived: boolean }[];
  categories: { id: string; name: string; type: "expense" | "income"; sort_order: number; archived: boolean }[];
}

export type MappingAction = "create" | "match" | "skip";

export interface AccountEntry {
  name: string;
  action: MappingAction;
  /** The name of an existing account, for match. */
  target?: string;
  color?: string;
  reason?: string;
}

export interface CategoryEntry {
  name: string;
  type: "expense" | "income" | "transfer";
  action: MappingAction;
  /** The name of an existing category, for match. */
  target?: string;
  icon?: string;
  color?: string;
  reason?: string;
}

/** The editable mapping.json. The keys are the source IDs as strings. */
export interface Mapping {
  currency: string;
  accounts: Record<string, AccountEntry>;
  categories: Record<string, CategoryEntry>;
  /** Source transaction IDs of the Carry rows that are opening balances. */
  opening_balances: number[];
  /**
   * Rows with no ProfileId. create puts them in a new archived account, so
   * they count in their month but not in Carry Over or the balances.
   */
  rows_without_account:
    | { action: "skip" }
    | { action: "match"; target: string }
    | { action: "create"; name: string };
  /**
   * Transfer rows with no partner row. import makes an expense of a negative
   * row and income of a positive row, in categories with these names.
   */
  unpaired_transfers:
    | { action: "skip"; reason?: string }
    | { action: "import"; expense_category: string; income_category: string };
  /**
   * For accounts with "carry positive only": an income row on the first day
   * after a month that ends below 0, so that the balance matches Spending Tracker.
   */
  carry_adjustments: { action: "skip"; reason?: string } | { action: "import"; category: string };
}

export type ProblemKind =
  | "unpaired_transfer"
  | "no_account"
  | "same_account_transfer"
  | "invalid_amount"
  | "category_type"
  | "unsupported_recurrence"
  | "missing_occurrence";

export interface Problem {
  kind: ProblemKind;
  sourceIds: number[];
  message: string;
}

export interface UploadOp {
  op: "PUT" | "PATCH";
  table: "accounts" | "categories" | "recurring_rules" | "transactions";
  id: string;
  data: Record<string, unknown>;
}

export type CountKey =
  | "accounts"
  | "categories"
  | "recurring_rules"
  | "transactions"
  | "transfers"
  | "occurrences"
  | "carry_adjustments";

export interface ImportPlan {
  ops: UploadOp[];
  problems: Problem[];
  counts: Record<CountKey, number>;
}
