import { occurrenceId } from "../../domain/ids";
import { validateRecurringRule, validateTransaction, type RecurringRuleInput, type TransactionInput } from "../../domain/validation";
import { importId } from "./convert";
import {
  BANK_ID,
  EATING_OUT_ID,
  GENERAL_ID,
  existingFixture,
  OTHER_INCOME_ID,
  row,
  sourceFixture,
  ticks,
  USER_ID,
  WALLET_ID,
} from "./fixtures";
import { proposeMapping } from "./mapping";
import { buildPlan } from "./plan";
import type { Existing, Mapping, SourceData, UploadOp } from "./types";

const BATCH_ID = "8c3d1b2a-0f9e-4d8c-b7a6-95f4e3d2c1b0";
const options = { userId: USER_ID, importBatchId: BATCH_ID, today: "2026-10-22" };

function plan(source: SourceData = sourceFixture(), edit?: (m: Mapping) => void, existing: Existing = existingFixture()) {
  const mapping = proposeMapping(source, existing);
  edit?.(mapping);
  return buildPlan(source, mapping, existing, options);
}

function op(ops: UploadOp[], table: UploadOp["table"], id: string): UploadOp | undefined {
  return ops.find((o) => o.table === table && o.id === id);
}

function transactionWithExternalId(ops: UploadOp[], externalId: string): UploadOp | undefined {
  return ops.find((o) => o.table === "transactions" && o.data.external_id === externalId);
}

describe("accounts and categories", () => {
  it("creates accounts after the existing ones, in source ID order", () => {
    const { ops, counts } = plan();
    expect(op(ops, "accounts", importId("account", 2, USER_ID))).toEqual({
      op: "PUT",
      table: "accounts",
      id: importId("account", 2, USER_ID),
      data: { user_id: USER_ID, name: "Bank A", color: "#AABBCC", sort_order: 2, opening_balance_minor: 10000 },
    });
    expect(op(ops, "accounts", importId("account", 3, USER_ID))?.data.sort_order).toBe(3);
    expect(op(ops, "accounts", importId("account", 4, USER_ID))?.data.sort_order).toBe(4);
    expect(counts.accounts).toBe(4);
  });

  it("uses the existing account for a match, and gives no op for a skip", () => {
    const source = sourceFixture();
    const { ops } = plan(source, (m) => {
      m.accounts[4] = { name: "Cash", action: "match", target: "Wallet" };
    });
    expect(op(ops, "accounts", importId("account", 4, USER_ID))).toBeUndefined();
    expect(op(ops, "accounts", importId("account", 1, USER_ID))).toBeUndefined();
    expect(op(ops, "accounts", WALLET_ID)).toBeUndefined();
    expect(transactionWithExternalId(ops, "st:104")?.data.account_id).toBe(WALLET_ID);
  });

  it("creates and matches categories, with no op for transfers", () => {
    const { ops, counts } = plan();
    expect(op(ops, "categories", importId("category", 25, USER_ID))).toEqual({
      op: "PUT",
      table: "categories",
      id: importId("category", 25, USER_ID),
      data: {
        user_id: USER_ID,
        type: "expense",
        name: "Pet food",
        icon: "cart",
        color: expect.stringMatching(/^#[0-9a-fA-F]{6}$/),
        sort_order: 5,
      },
    });
    expect(op(ops, "categories", importId("category", 4, USER_ID))).toBeUndefined();
    expect(op(ops, "categories", importId("category", 14, USER_ID))).toBeUndefined();
    expect(transactionWithExternalId(ops, "st:101")?.data.category_id).toBe(EATING_OUT_ID);
    expect(counts.categories).toBe(3);
  });

  it("adds the opening balances to the account", () => {
    const source = sourceFixture();
    source.transactions.push(row({ Id: 111, Type: "Income", Amount: 5, CategoryId: 15, Date: ticks("2024-01-01") }));
    const { ops } = plan(source, (m) => {
      m.opening_balances = [110, 111, 113];
    });
    expect(op(ops, "accounts", importId("account", 2, USER_ID))?.data.opening_balance_minor).toBe(10500);
  });

  it("patches the opening balance of a matched account", () => {
    const { ops } = plan(sourceFixture(), (m) => {
      m.accounts[2] = { name: "Bank A", action: "match", target: "Bank" };
    });
    expect(ops.filter((o) => o.table === "accounts" && o.id === BANK_ID)).toEqual([
      { op: "PATCH", table: "accounts", id: BANK_ID, data: { opening_balance_minor: 10000 } },
    ]);
  });

  it("orders the ops: accounts, categories, recurring rules, transactions", () => {
    const tables = plan().ops.map((o) => o.table);
    const order = ["accounts", "categories", "recurring_rules", "transactions"];
    const ranks = tables.map((t) => order.indexOf(t));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(tables)).toEqual(new Set(order));
  });

  it("keeps the sort order of accounts and categories that an earlier import created", () => {
    const source = sourceFixture();
    const first = plan(source);
    const existing = existingFixture();
    for (const o of first.ops) {
      if (o.table === "accounts" && o.op === "PUT") {
        existing.accounts.push({
          id: o.id,
          name: o.data.name as string,
          sort_order: o.data.sort_order as number,
          opening_balance_minor: 0,
          archived: Boolean(o.data.archived_at),
        });
      }
      if (o.table === "categories") {
        existing.categories.push({
          id: o.id,
          name: o.data.name as string,
          type: o.data.type as "expense" | "income",
          sort_order: o.data.sort_order as number,
          archived: false,
        });
      }
    }
    const second = buildPlan(source, proposeMapping(source, existingFixture()), existing, options);
    const sortOrders = (ops: UploadOp[]) =>
      ops.filter((o) => o.op === "PUT" && (o.table === "accounts" || o.table === "categories")).map((o) => [o.id, o.data.sort_order]);
    expect(sortOrders(second.ops)).toEqual(sortOrders(first.ops));
  });

  it("gives the same plan for the same input", () => {
    expect(plan()).toEqual(plan());
  });
});

describe("transactions", () => {
  it("imports an expense row", () => {
    const { ops } = plan();
    expect(op(ops, "transactions", importId("transaction", 101, USER_ID))?.data).toEqual({
      user_id: USER_ID,
      type: "expense",
      amount_minor: 1250,
      currency_code: "EUR",
      date: "2026-09-01",
      name: "Lunch",
      note: null,
      category_id: EATING_OUT_ID,
      account_id: importId("account", 2, USER_ID),
      to_account_id: null,
      recurring_rule_id: null,
      source: "import",
      import_batch_id: BATCH_ID,
      external_id: "st:101",
    });
  });

  it("imports a later Carry Over row as income, and an opening balance as no row", () => {
    const { ops } = plan();
    expect(op(ops, "transactions", importId("transaction", 112, USER_ID))?.data).toMatchObject({
      type: "income",
      amount_minor: 2000,
      category_id: OTHER_INCOME_ID,
    });
    expect(transactionWithExternalId(ops, "st:110")).toBeUndefined();
    expect(transactionWithExternalId(ops, "st:113")).toBeUndefined();
  });

  it("joins the two rows of a transfer", () => {
    const { ops, counts } = plan();
    expect(op(ops, "transactions", importId("transfer", 201, USER_ID))?.data).toMatchObject({
      type: "transfer",
      account_id: importId("account", 3, USER_ID),
      to_account_id: importId("account", 2, USER_ID),
      amount_minor: 5000,
      category_id: null,
      external_id: "st:201+202",
    });
    expect(transactionWithExternalId(ops, "st:202")).toBeUndefined();
    expect(counts.transfers).toBe(1);
  });

  it.each([
    ["another date", { Date: ticks("2026-09-06") }],
    ["the same sign", { Amount: -10 }],
    ["the same account", { ProfileId: 3 }],
  ])("reports a transfer row whose next row has %s", (_, change) => {
    const source = sourceFixture();
    source.transactions.push(
      row({ Id: 210, Type: "Transfer", Amount: -10, ProfileId: 3, CategoryId: 14, Date: ticks("2026-09-05") }),
      row({ Id: 211, Type: "Transfer", Amount: 10, ProfileId: 2, CategoryId: 14, Date: ticks("2026-09-05"), ...change }),
    );
    const { ops, problems } = plan(source);
    expect(problems.filter((p) => p.kind === "unpaired_transfer").map((p) => p.sourceIds)).toEqual([[210], [211]]);
    expect(transactionWithExternalId(ops, "st:210+211")).toBeUndefined();
  });

  it("reports a transfer that rounds to 0", () => {
    const source = sourceFixture();
    source.transactions.push(
      row({ Id: 250, Type: "Transfer", Amount: -0.004, ProfileId: 3, CategoryId: 14 }),
      row({ Id: 251, Type: "Transfer", Amount: 0.004, ProfileId: 2, CategoryId: 14 }),
    );
    const { ops, problems } = plan(source);
    expect(problems).toContainEqual(expect.objectContaining({ kind: "invalid_amount", sourceIds: [250, 251] }));
    expect(transactionWithExternalId(ops, "st:250+251")).toBeUndefined();
  });

  it("pairs a row with the next transfer row, also over a gap in the IDs", () => {
    const source = sourceFixture();
    source.transactions.push(
      row({ Id: 220, Type: "Transfer", Amount: -10, ProfileId: 3, CategoryId: 14 }),
      row({ Id: 221, Amount: 2 }),
      row({ Id: 223, Type: "Transfer", Amount: 10, ProfileId: 2, CategoryId: 14 }),
    );
    const { ops, problems } = plan(source);
    expect(problems.filter((p) => p.kind === "unpaired_transfer")).toEqual([]);
    expect(op(ops, "transactions", importId("transfer", 220, USER_ID))?.data.external_id).toBe("st:220+223");
  });

  it("imports an unpaired transfer row as an expense or income", () => {
    const source = sourceFixture();
    source.transactions.push(
      row({ Id: 270, Type: "Transfer", Amount: -12.5, ProfileId: 3, CategoryId: 14, Date: ticks("2026-09-10") }),
      row({ Id: 271, Type: "Transfer", Amount: 4, ProfileId: 2, CategoryId: 14, Date: ticks("2026-09-11") }),
    );
    const { ops, problems } = plan(source);
    expect(op(ops, "transactions", importId("transaction", 270, USER_ID))?.data).toMatchObject({
      type: "expense",
      amount_minor: 1250,
      category_id: GENERAL_ID,
      account_id: importId("account", 3, USER_ID),
    });
    expect(op(ops, "transactions", importId("transaction", 271, USER_ID))?.data).toMatchObject({
      type: "income",
      amount_minor: 400,
      category_id: OTHER_INCOME_ID,
      account_id: importId("account", 2, USER_ID),
    });
    expect(problems.filter((p) => p.kind === "unpaired_transfer").map((p) => p.message)).toEqual([
      expect.stringMatching(/270 .*imports as expense/),
      expect.stringMatching(/271 .*imports as income/),
    ]);
  });

  it("skips an unpaired transfer row when the mapping says skip", () => {
    const source = sourceFixture();
    source.transactions.push(row({ Id: 270, Type: "Transfer", Amount: -12.5, ProfileId: 3, CategoryId: 14 }));
    const { ops } = plan(source, (m) => {
      m.unpaired_transfers = { action: "skip" };
    });
    expect(transactionWithExternalId(ops, "st:270")).toBeUndefined();
  });

  it("reports a transfer between two profiles of one account", () => {
    const { ops, problems } = plan(sourceFixture(), (m) => {
      m.accounts[2] = { name: "Bank A", action: "match", target: "Wallet" };
      m.accounts[3] = { name: "Card B", action: "match", target: "Wallet" };
    });
    expect(problems).toContainEqual(expect.objectContaining({ kind: "same_account_transfer", sourceIds: [201, 202] }));
    expect(op(ops, "transactions", importId("transfer", 201, USER_ID))).toBeUndefined();
  });

  it("puts rows without an account in a new archived account", () => {
    const { ops } = plan();
    const id = importId("account", "none", USER_ID);
    expect(op(ops, "accounts", id)?.data).toMatchObject({
      name: "No account",
      archived_at: "2026-10-22T00:00:00Z",
      sort_order: 5,
      exclude_from_carry_over: true,
    });
    expect(transactionWithExternalId(ops, "st:120")?.data.account_id).toBe(id);
  });

  it("does not import an unpaired transfer half without an account", () => {
    const source = sourceFixture();
    source.transactions.push(row({ Id: 280, Type: "Transfer", Amount: -5, ProfileId: null, CategoryId: 14 }));
    expect(transactionWithExternalId(plan(source).ops, "st:280")).toBeUndefined();
  });

  it("skips or maps a row without an account", () => {
    const skipped = plan(sourceFixture(), (m) => {
      m.rows_without_account = { action: "skip" };
    });
    expect(skipped.problems).toContainEqual(expect.objectContaining({ kind: "no_account", sourceIds: [120] }));
    expect(transactionWithExternalId(skipped.ops, "st:120")).toBeUndefined();

    const mapped = plan(sourceFixture(), (m) => {
      m.rows_without_account = { action: "match", target: "Wallet" };
    });
    expect(transactionWithExternalId(mapped.ops, "st:120")?.data.account_id).toBe(WALLET_ID);
  });

  it("reports a transfer half without an account as unpaired", () => {
    const source = sourceFixture();
    source.transactions.push(
      row({ Id: 230, Type: "Transfer", Amount: -10, ProfileId: null, CategoryId: 14 }),
      row({ Id: 231, Type: "Transfer", Amount: 10, ProfileId: 2, CategoryId: 14 }),
    );
    const { problems } = plan(source, (m) => {
      m.rows_without_account = { action: "match", target: "Wallet" };
    });
    expect(problems.filter((p) => p.kind === "unpaired_transfer").map((p) => p.sourceIds)).toEqual([[230], [231]]);
  });

  it("uses the category with the same name and the row type", () => {
    const source = sourceFixture();
    source.transactions.push(row({ Id: 260, Type: "Income", Amount: 8, CategoryId: 30 }));
    const { ops } = plan(source);
    expect(op(ops, "transactions", importId("transaction", 260, USER_ID))?.data).toMatchObject({
      type: "income",
      category_id: importId("category", 31, USER_ID),
    });
  });

  it("reports a row in a category of another type with no such category of the row type", () => {
    const source = sourceFixture();
    source.transactions.push(row({ Id: 261, Type: "Income", Amount: 8, CategoryId: 25 }));
    const { ops, problems } = plan(source);
    expect(problems).toContainEqual(expect.objectContaining({ kind: "category_type", sourceIds: [261] }));
    expect(transactionWithExternalId(ops, "st:261")).toBeUndefined();
  });

  it.each([0, -5, 0.001])("reports an expense with the amount %p", (amount) => {
    const source = sourceFixture();
    source.transactions.push(row({ Id: 240, Amount: amount }));
    const { ops, problems } = plan(source);
    expect(problems).toContainEqual(expect.objectContaining({ kind: "invalid_amount", sourceIds: [240] }));
    expect(transactionWithExternalId(ops, "st:240")).toBeUndefined();
  });

  it("gives only transactions that pass the app validation", () => {
    const existing = existingFixture();
    const { ops } = plan(sourceFixture(), (m) => {
      m.rows_without_account = { action: "match", target: "Wallet" };
    });
    const types = new Map<string, "expense" | "income">(existing.categories.map((c) => [c.id, c.type]));
    for (const o of ops) if (o.table === "categories") types.set(o.id, o.data.type as "expense" | "income");

    const transactions = ops.filter((o) => o.table === "transactions");
    expect(transactions.length).toBeGreaterThan(0);
    for (const o of transactions) {
      const input = o.data as unknown as TransactionInput;
      expect([o.data.external_id, validateTransaction(input, types.get(String(input.category_id)) ?? null)]).toEqual([
        o.data.external_id,
        [],
      ]);
    }
  });
});

describe("carry positive only", () => {
  it("adds an income row after a month that ends below 0", () => {
    const source = sourceFixture();
    source.strategies.push({ ProfileId: 3, CarryPositiveOnly: 1 });
    const { ops, counts } = plan(source);
    // Card B: 30.00 in 2024-02, then 5.00 and a transfer of 50.00 out in 2026-09.
    expect(op(ops, "transactions", importId("carry_adjustment", "3:2026-09", USER_ID))?.data).toMatchObject({
      type: "income",
      amount_minor: 2500,
      date: "2026-10-01",
      name: "Carry Over adjustment",
      category_id: OTHER_INCOME_ID,
      account_id: importId("account", 3, USER_ID),
      external_id: "st:carry:3:2026-09",
    });
    expect(counts.carry_adjustments).toBe(1);
  });

  it("adds no row without the setting or when the mapping says skip", () => {
    expect(plan().counts.carry_adjustments).toBe(0);
    const source = sourceFixture();
    source.strategies.push({ ProfileId: 3, CarryPositiveOnly: 1 });
    const skipped = plan(source, (m) => {
      m.carry_adjustments = { action: "skip" };
    });
    expect(skipped.counts.carry_adjustments).toBe(0);
  });

  it("uses the default strategy for a profile without its own", () => {
    const source = sourceFixture();
    source.strategies = [{ ProfileId: null, CarryPositiveOnly: 1 }];
    expect(op(plan(source).ops, "transactions", importId("carry_adjustment", "3:2026-09", USER_ID))).toBeDefined();
  });
});

describe("recurring", () => {
  const ruleId = importId("rule", 1, USER_ID);

  it("imports a monthly rule", () => {
    const { ops, counts } = plan();
    expect(op(ops, "recurring_rules", ruleId)?.data).toEqual({
      user_id: USER_ID,
      type: "expense",
      amount_minor: 999,
      name: "Streaming",
      note: null,
      category_id: EATING_OUT_ID,
      account_id: importId("account", 2, USER_ID),
      to_account_id: null,
      frequency: "monthly",
      start_date: "2026-07-31",
      end_date: null,
      generated_through: "2026-09-30",
    });
    expect(counts.recurring_rules).toBe(1);
  });

  it.each([
    ["Daily", 1, "daily"],
    ["Weekly", 1, "weekly"],
    ["Weekly", 2, "biweekly"],
    ["Monthly", 1, "monthly"],
    ["Monthly", 3, "quarterly"],
    ["Yearly", 1, "yearly"],
    ["Monthly", 12, "yearly"],
  ])("maps %s every %p to %s", (type, period, frequency) => {
    const source = sourceFixture();
    source.recurring[0] = { ...source.recurring[0], RecurringType: type, RecurringPeriod: period };
    expect(op(plan(source).ops, "recurring_rules", ruleId)?.data.frequency).toBe(frequency);
  });

  it.each([
    ["Monthly", 6, "Expense"],
    ["Daily", 2, "Expense"],
    ["Monthly", 1, "Transfer"],
  ] as const)("reports a rule of %s every %p of type %s, and imports its rows as normal rows", (type, period, kind) => {
    const source = sourceFixture();
    source.recurring[0] = { ...source.recurring[0], RecurringType: type, RecurringPeriod: period, Type: kind };
    const { ops, problems, counts } = plan(source);
    expect(problems).toContainEqual(expect.objectContaining({ kind: "unsupported_recurrence", sourceIds: [1] }));
    expect(op(ops, "recurring_rules", ruleId)).toBeUndefined();
    expect(op(ops, "transactions", importId("transaction", 301, USER_ID))?.data.recurring_rule_id).toBeNull();
    expect(op(ops, "transactions", importId("transaction", 304, USER_ID))).toBeDefined();
    expect(counts.occurrences).toBe(0);
  });

  it("gives the past linked rows the occurrence IDs", () => {
    const { ops, counts } = plan();
    for (const [id, date] of [
      [301, "2026-07-31"],
      [302, "2026-08-31"],
      [303, "2026-09-30"],
    ] as const) {
      expect(op(ops, "transactions", occurrenceId(ruleId, date))?.data).toMatchObject({
        source: "recurring",
        recurring_rule_id: ruleId,
        date,
        external_id: `st:${id}`,
      });
    }
    expect(counts.occurrences).toBe(4);
  });

  it("gives a linked row after today on the schedule the occurrence ID", () => {
    const { ops, counts } = plan();
    expect(op(ops, "transactions", occurrenceId(ruleId, "2026-10-31"))?.data).toMatchObject({
      source: "recurring",
      recurring_rule_id: ruleId,
      date: "2026-10-31",
      external_id: "st:304",
    });
    expect(counts.occurrences).toBe(4);
  });

  it("imports a linked row after today off the schedule as a normal row", () => {
    const source = sourceFixture();
    source.transactions.push(row({ Id: 306, Amount: 9.99, RecurringTransactionId: 1, Date: ticks("2026-11-15") }));
    expect(op(plan(source).ops, "transactions", importId("transaction", 306, USER_ID))?.data).toMatchObject({
      source: "import",
      recurring_rule_id: null,
      date: "2026-11-15",
    });
  });

  it("imports a linked row off the schedule as a normal row", () => {
    const { ops } = plan();
    expect(op(ops, "transactions", importId("transaction", 305, USER_ID))?.data).toMatchObject({
      source: "import",
      recurring_rule_id: null,
      date: "2026-08-15",
    });
  });

  it("keeps a rule with a deleted occurrence and marks the past dates as generated", () => {
    const source = sourceFixture();
    source.transactions = source.transactions.filter((t) => t.Id !== 302);
    const { ops, problems, counts } = plan(source);
    expect(problems).toContainEqual({
      kind: "missing_occurrence",
      sourceIds: [1],
      message: expect.stringMatching(/no row on 2026-08-31; the app does not create/),
    });
    expect(op(ops, "recurring_rules", ruleId)?.data).toMatchObject({
      start_date: "2026-07-31",
      generated_through: "2026-09-30",
    });
    expect(op(ops, "transactions", occurrenceId(ruleId, "2026-07-31"))?.data.external_id).toBe("st:301");
    expect(op(ops, "transactions", occurrenceId(ruleId, "2026-09-30"))?.data.external_id).toBe("st:303");
    expect(op(ops, "transactions", occurrenceId(ruleId, "2026-10-31"))?.data.external_id).toBe("st:304");
    expect(counts.occurrences).toBe(3);
  });

  it("keeps an ended rule with a deleted occurrence", () => {
    const source = sourceFixture();
    source.transactions = source.transactions.filter((t) => t.Id !== 302 && t.Id !== 304);
    source.recurring[0] = { ...source.recurring[0], EndDate: ticks("2026-10-15") };
    const { ops } = plan(source);
    expect(op(ops, "recurring_rules", ruleId)?.data).toMatchObject({
      end_date: "2026-10-15",
      generated_through: "2026-09-30",
    });
    expect(op(ops, "transactions", occurrenceId(ruleId, "2026-09-30"))?.data.external_id).toBe("st:303");
  });

  it("marks the past dates after the latest row of the backup as deleted", () => {
    const source = sourceFixture();
    source.transactions = source.transactions.filter((t) => t.Id !== 303 && t.Id !== 304);
    const { ops, problems } = plan(source);
    expect(op(ops, "recurring_rules", ruleId)?.data.generated_through).toBe("2026-09-30");
    expect(problems).toContainEqual({
      kind: "missing_occurrence",
      sourceIds: [1],
      message: "rule 1: no row on 2026-09-30; the app does not create these dates again",
    });
  });

  it("reports all past gaps, before and after the latest row of the backup", () => {
    const source = sourceFixture();
    source.transactions = source.transactions.filter((t) => t.Id !== 301 && t.Id !== 303 && t.Id !== 304);
    const { ops, problems } = plan(source);
    expect(op(ops, "recurring_rules", ruleId)?.data.generated_through).toBe("2026-09-30");
    expect(problems).toContainEqual({
      kind: "missing_occurrence",
      sourceIds: [1],
      message: "rule 1: no row on 2026-07-31, 2026-09-30; the app does not create these dates again",
    });
  });

  it("marks all past dates of a rule with no rows in the backup as deleted", () => {
    const source = sourceFixture();
    source.transactions = source.transactions.filter((t) => t.RecurringTransactionId !== 1);
    const { ops, problems } = plan(source);
    expect(op(ops, "recurring_rules", ruleId)?.data.generated_through).toBe("2026-09-30");
    expect(problems).toContainEqual({
      kind: "missing_occurrence",
      sourceIds: [1],
      message: "rule 1: no row on 2026-07-31, 2026-08-31, 2026-09-30; the app does not create these dates again",
    });
  });

  it("leaves generated_through empty for a rule that starts after today", () => {
    const source = sourceFixture();
    source.recurring[0] = { ...source.recurring[0], Date: ticks("2026-10-31") };
    expect(op(plan(source).ops, "recurring_rules", ruleId)?.data).toMatchObject({
      start_date: "2026-10-31",
      generated_through: null,
    });
  });

  it("reports a rule that ends before it starts, and imports its rows as normal rows", () => {
    const source = sourceFixture();
    source.recurring[0] = { ...source.recurring[0], EndDate: ticks("2026-07-01") };
    const { ops, problems } = plan(source);
    expect(problems).toContainEqual(expect.objectContaining({ kind: "unsupported_recurrence", sourceIds: [1] }));
    expect(op(ops, "recurring_rules", ruleId)).toBeUndefined();
    expect(op(ops, "transactions", importId("transaction", 301, USER_ID))?.data.recurring_rule_id).toBeNull();
  });

  it("gives only rules that pass the app validation", () => {
    const { ops } = plan();
    const rules = ops.filter((o) => o.table === "recurring_rules");
    expect(rules).toHaveLength(1);
    for (const o of rules) {
      expect(validateRecurringRule(o.data as unknown as RecurringRuleInput, "expense")).toEqual([]);
    }
  });
});
