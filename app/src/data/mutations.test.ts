import { asyncDatabase, createTestDatabase, loadFixture, type AsyncTestDatabase, type TestDatabase } from "../../test/sqlite";
import { MAX_AMOUNT_MINOR } from "../domain/money";
import {
  archiveAccount,
  archiveCategory,
  deleteAccount,
  deleteCategory,
  restoreAccount,
  restoreCategory,
  saveAccount,
  saveCategory,
  saveCategoryBudget,
  saveRecurringRule,
  saveTransaction,
  updateSettings,
  type TransactionInput,
} from "./mutations";

const fixture = {
  user_settings: [
    {
      id: "s1",
      user_id: "u1",
      currency_code: "BGN",
      time_period: "monthly",
      week_start_day: 1,
      month_start_day: 1,
      year_start_month: 1,
      budget_mode: false,
      carry_over: true,
      hide_future: false,
      show_note: true,
      theme: "system",
      summary_font: "mono",
      icon_style: "filled",
    },
  ],
  accounts: [
    { id: "wallet", user_id: "u1", name: "Wallet", color: "#000000", sort_order: 0 },
    { id: "bank", user_id: "u1", name: "Bank", color: "#000000", sort_order: 1 },
    { id: "spare", user_id: "u1", name: "Spare", color: "#000000", sort_order: 2 },
  ],
  categories: [
    { id: "food", user_id: "u1", type: "expense", name: "Groceries", icon: "cart", color: "#000000", sort_order: 0 },
    { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "coins", color: "#000000", sort_order: 1 },
    { id: "unused", user_id: "u1", type: "expense", name: "Unused", icon: "tag", color: "#000000", sort_order: 2 },
  ],
  transactions: [
    {
      id: "t1",
      user_id: "u1",
      type: "expense",
      amount_minor: 1499,
      currency_code: "BGN",
      date: "2026-10-01",
      name: "Lidl",
      category_id: "food",
      account_id: "wallet",
      source: "manual",
    },
  ],
};

const expense: TransactionInput = {
  type: "expense",
  amount_minor: 250,
  date: "2026-10-19",
  name: "Coffee",
  category_id: "food",
  account_id: "wallet",
};

let sqlite: TestDatabase;
let db: AsyncTestDatabase;

beforeEach(() => {
  sqlite = createTestDatabase();
  loadFixture(sqlite, fixture);
  db = asyncDatabase(sqlite);
});

function row(table: string, id: string) {
  return sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

function updateStatements(spy: jest.SpyInstance): string[] {
  return spy.mock.calls.map(([sql]) => sql as string).filter((sql) => sql.startsWith("UPDATE"));
}

describe("saveTransaction", () => {
  it("inserts a new transaction with the user and currency from the settings", async () => {
    const result = await saveTransaction(db, expense);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row("transactions", result.id)).toMatchObject({
      user_id: "u1",
      currency_code: "BGN",
      source: "manual",
      type: "expense",
      amount_minor: 250,
      date: "2026-10-19",
      name: "Coffee",
      category_id: "food",
      account_id: "wallet",
      to_account_id: null,
      note: null,
    });
  });

  it.each([
    [{ amount_minor: 0 }, "amount_minor", "out_of_range"],
    [{ amount_minor: 1.5 }, "amount_minor", "out_of_range"],
    [{ amount_minor: 1_000_000_000_001 }, "amount_minor", "out_of_range"],
    [{ date: "2026-02-30" }, "date", "invalid"],
    [{ name: "x".repeat(121) }, "name", "too_long"],
    [{ note: "x".repeat(2001) }, "note", "too_long"],
    [{ category_id: null }, "category_id", "required"],
    [{ category_id: "salary" }, "category_id", "invalid_category_type"],
    [{ category_id: "missing" }, "category_id", "invalid_reference"],
    [{ account_id: "missing" }, "account_id", "invalid_reference"],
    [{ to_account_id: "bank" }, "to_account_id", "invalid"],
  ])("rejects %j with %s %s", async (change, field, code) => {
    const result = await saveTransaction(db, { ...expense, ...change });

    expect(result).toEqual({ ok: false, errors: [{ field, code }] });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 1 });
  });

  it.each([
    [{ category_id: "food", to_account_id: "bank" }, "category_id", "invalid_transfer"],
    [{ to_account_id: null }, "to_account_id", "required"],
    [{ to_account_id: "wallet" }, "to_account_id", "invalid_transfer"],
    [{ to_account_id: "missing" }, "to_account_id", "invalid_reference"],
  ])("applies the transfer rules to %j", async (change, field, code) => {
    const transfer: TransactionInput = {
      type: "transfer",
      amount_minor: 1000,
      date: "2026-10-19",
      name: "",
      account_id: "wallet",
      to_account_id: "bank",
    };

    expect(await saveTransaction(db, { ...transfer, ...change })).toEqual({ ok: false, errors: [{ field, code }] });
  });

  it("saves a valid transfer without a category", async () => {
    const result = await saveTransaction(db, {
      type: "transfer",
      amount_minor: 1000,
      date: "2026-10-19",
      name: "",
      account_id: "wallet",
      to_account_id: "bank",
    });

    expect(result.ok).toBe(true);
  });

  it("updates only the changed columns on edit", async () => {
    const spy = jest.spyOn(db, "execute");

    const result = await saveTransaction(db, {
      id: "t1",
      type: "expense",
      amount_minor: 1599,
      date: "2026-10-01",
      name: "Lidl",
      category_id: "food",
      account_id: "wallet",
      note: "milk",
    });

    expect(result).toEqual({ ok: true, id: "t1" });
    expect(updateStatements(spy)).toEqual(["UPDATE transactions SET amount_minor = ?, note = ? WHERE id = ?"]);
    expect(row("transactions", "t1")).toMatchObject({ amount_minor: 1599, note: "milk", source: "manual" });
  });

  it("writes nothing when an edit changes nothing", async () => {
    const spy = jest.spyOn(db, "execute");

    const result = await saveTransaction(db, {
      id: "t1",
      type: "expense",
      amount_minor: 1499,
      date: "2026-10-01",
      name: "Lidl",
      category_id: "food",
      account_id: "wallet",
    });

    expect(result).toEqual({ ok: true, id: "t1" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("categories", () => {
  it("inserts a category after the last one", async () => {
    const result = await saveCategory(db, { type: "income", name: "Gifts", icon: "gift", color: "#aabbcc" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(row("categories", result.id)).toMatchObject({
      user_id: "u1",
      type: "income",
      name: "Gifts",
      icon: "gift",
      color: "#aabbcc",
      sort_order: 3,
      archived_at: null,
    });
  });

  it.each([
    [{ name: "" }, "name", "required"],
    [{ name: "x".repeat(61) }, "name", "too_long"],
    [{ icon: "" }, "icon", "required"],
    [{ color: "red" }, "color", "invalid"],
  ])("rejects %j", async (change, field, code) => {
    const input = { type: "expense" as const, name: "Pets", icon: "pet", color: "#112233", ...change };

    expect(await saveCategory(db, input)).toEqual({ ok: false, errors: [{ field, code }] });
  });

  it("updates only the changed columns on edit", async () => {
    const spy = jest.spyOn(db, "execute");

    const result = await saveCategory(db, {
      id: "food",
      type: "expense",
      name: "Food",
      icon: "cart",
      color: "#000000",
      sort_order: 0,
    });

    expect(result).toEqual({ ok: true, id: "food" });
    expect(updateStatements(spy)).toEqual(["UPDATE categories SET name = ? WHERE id = ?"]);
  });

  it("archives a category", async () => {
    await archiveCategory(db, "food");

    expect(row("categories", "food")?.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("restores an archived category", async () => {
    await archiveCategory(db, "food");
    await restoreCategory(db, "food");

    expect(row("categories", "food")?.archived_at).toBeNull();
  });

  describe("duplicate names", () => {
    const duplicate = {
      ok: false,
      errors: [{ field: "name", code: "invalid", message: "A category with this name exists." }],
    };
    const pets = { type: "expense" as const, icon: "pet", color: "#112233" };

    it.each(["Groceries", "  groceries ", "GROCERIES"])("rejects a new category named %j", async (name) => {
      expect(await saveCategory(db, { ...pets, name })).toEqual(duplicate);
    });

    it("compares non-ASCII names in any letter case", async () => {
      await saveCategory(db, { ...pets, name: "Храна" });
      expect(await saveCategory(db, { ...pets, name: "ХРАНА" })).toEqual(duplicate);
    });

    it("rejects a rename to the name of another category", async () => {
      expect(await saveCategory(db, { ...pets, id: "unused", name: "groceries" })).toEqual(duplicate);
      expect(row("categories", "unused")?.name).toBe("Unused");
    });

    it("rejects a change of type to a type with the same name", async () => {
      await saveCategory(db, { ...pets, type: "income", id: "x", name: "Unused" });
      expect(await saveCategory(db, { ...pets, type: "income", id: "unused", name: "Unused" })).toEqual(duplicate);
    });

    it("allows the same name for the other type, an archived category, and the edited category", async () => {
      expect(await saveCategory(db, { ...pets, type: "income", name: "Groceries" })).toMatchObject({ ok: true });
      await archiveCategory(db, "unused");
      expect(await saveCategory(db, { ...pets, name: "unused" })).toMatchObject({ ok: true });
      expect(await saveCategory(db, { ...pets, id: "food", name: "groceries " })).toMatchObject({ ok: true });
    });

    it("allows a restore that makes a duplicate, and later edits of the restored category", async () => {
      await archiveCategory(db, "unused");
      await saveCategory(db, { ...pets, name: "Unused" });
      await restoreCategory(db, "unused");

      expect(row("categories", "unused")?.archived_at).toBeNull();
      expect(await saveCategory(db, { ...pets, id: "unused", name: "Unused", sort_order: 5 })).toEqual({ ok: true, id: "unused" });
    });
  });

  it("refuses to delete a category that transactions use", async () => {
    expect(await deleteCategory(db, "food")).toEqual({ ok: false, errors: [{ field: "id", code: "in_use" }] });
    expect(row("categories", "food")).toBeDefined();
  });

  it("deletes an unused category", async () => {
    expect(await deleteCategory(db, "unused")).toEqual({ ok: true, id: "unused" });
    expect(row("categories", "unused")).toBeUndefined();
  });
});

describe("accounts", () => {
  it("inserts an account after the last one", async () => {
    const result = await saveAccount(db, { name: "Revolut", color: "#0000ff" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(row("accounts", result.id)).toMatchObject({
      user_id: "u1",
      name: "Revolut",
      color: "#0000ff",
      sort_order: 3,
      archived_at: null,
    });
  });

  it("stores the opening balance", async () => {
    const result = await saveAccount(db, { name: "Savings", color: "#0000ff", opening_balance_minor: -5000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(row("accounts", result.id)).toMatchObject({ opening_balance_minor: -5000 });
  });

  it("rejects an opening balance that is not an integer", async () => {
    const result = await saveAccount(db, { name: "Savings", color: "#0000ff", opening_balance_minor: 1.5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({ field: "opening_balance_minor", code: "invalid" });
  });

  it("rejects an account without a name", async () => {
    expect(await saveAccount(db, { name: "", color: "#0000ff" })).toEqual({
      ok: false,
      errors: [{ field: "name", code: "required" }],
    });
  });

  it("updates only the changed columns on edit", async () => {
    const spy = jest.spyOn(db, "execute");

    await saveAccount(db, { id: "bank", name: "Bank", color: "#ff0000", sort_order: 1 });

    expect(updateStatements(spy)).toEqual(["UPDATE accounts SET color = ? WHERE id = ?"]);
  });

  it("archives an account", async () => {
    await archiveAccount(db, "bank");

    expect(row("accounts", "bank")?.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("restores an archived account", async () => {
    await archiveAccount(db, "bank");
    await restoreAccount(db, "bank");

    expect(row("accounts", "bank")?.archived_at).toBeNull();
  });

  describe("duplicate names", () => {
    const duplicate = {
      ok: false,
      errors: [{ field: "name", code: "invalid", message: "An account with this name exists." }],
    };

    it.each(["Bank", " bank", "BANK "])("rejects a new account named %j", async (name) => {
      expect(await saveAccount(db, { name, color: "#0000ff" })).toEqual(duplicate);
    });

    it("rejects a rename to the name of another account", async () => {
      expect(await saveAccount(db, { id: "spare", name: "wallet", color: "#000000" })).toEqual(duplicate);
      expect(row("accounts", "spare")?.name).toBe("Spare");
    });

    it("allows the name of an archived account and of the edited account", async () => {
      await archiveAccount(db, "spare");
      expect(await saveAccount(db, { name: "Spare", color: "#0000ff" })).toMatchObject({ ok: true });
      expect(await saveAccount(db, { id: "bank", name: "BANK", color: "#000000" })).toEqual({ ok: true, id: "bank" });
    });

    it("allows a restore that makes a duplicate, and later edits of the restored account", async () => {
      await archiveAccount(db, "spare");
      await saveAccount(db, { name: "Spare", color: "#0000ff" });
      await restoreAccount(db, "spare");

      expect(row("accounts", "spare")?.archived_at).toBeNull();
      expect(await saveAccount(db, { id: "spare", name: "Spare", color: "#000000", sort_order: 7 })).toEqual({ ok: true, id: "spare" });
    });
  });

  it("refuses to delete an account that transactions use", async () => {
    expect(await deleteAccount(db, "wallet")).toEqual({ ok: false, errors: [{ field: "id", code: "in_use" }] });
    expect(row("accounts", "wallet")).toBeDefined();
  });

  it("refuses to delete the target account of a transfer", async () => {
    await saveTransaction(db, {
      type: "transfer",
      amount_minor: 100,
      date: "2026-10-19",
      name: "",
      account_id: "wallet",
      to_account_id: "spare",
    });

    expect(await deleteAccount(db, "spare")).toEqual({ ok: false, errors: [{ field: "id", code: "in_use" }] });
  });

  it("deletes an unused account", async () => {
    expect(await deleteAccount(db, "spare")).toEqual({ ok: true, id: "spare" });
    expect(row("accounts", "spare")).toBeUndefined();
  });
});

describe("saveRecurringRule", () => {
  const rule = {
    type: "expense" as const,
    amount_minor: 80000,
    name: "Rent",
    category_id: "food",
    account_id: "bank",
    frequency: "monthly" as const,
    start_date: "2026-09-01",
  };

  it("inserts the rule and generates the due occurrences", async () => {
    const result = await saveRecurringRule(db, rule, "2026-10-19");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(row("recurring_rules", result.id)).toMatchObject({ user_id: "u1", frequency: "monthly", end_date: null });
    const dates = sqlite
      .prepare("SELECT date FROM transactions WHERE recurring_rule_id = ? ORDER BY date")
      .all(result.id);
    expect(dates).toEqual([{ date: "2026-09-01" }, { date: "2026-10-01" }]);
  });

  function occurrenceDatesOf(ruleId: string) {
    return (
      sqlite.prepare("SELECT date FROM transactions WHERE recurring_rule_id = ? ORDER BY date").all(ruleId) as {
        date: string;
      }[]
    ).map((r) => r.date);
  }

  it("saves a quarterly rule", async () => {
    const result = await saveRecurringRule(db, { ...rule, frequency: "quarterly", start_date: "2026-04-01" }, "2026-10-19");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(occurrenceDatesOf(result.id)).toEqual(["2026-04-01", "2026-07-01", "2026-10-01"]);
  });

  it("keeps generated_through on an edit that keeps the schedule, so a deleted occurrence stays deleted", async () => {
    const result = await saveRecurringRule(db, rule, "2026-10-19");
    if (!result.ok) throw new Error("save failed");
    sqlite.prepare("DELETE FROM transactions WHERE recurring_rule_id = ? AND date = '2026-09-01'").run(result.id);

    await saveRecurringRule(db, { ...rule, id: result.id, name: "Flat rent", end_date: "2027-12-31" }, "2026-10-19");

    expect(row("recurring_rules", result.id)).toMatchObject({ name: "Flat rent", generated_through: "2026-10-01" });
    expect(occurrenceDatesOf(result.id)).toEqual(["2026-10-01"]);
  });

  it.each([
    ["start_date", { start_date: "2026-08-15" }, ["2026-09-01", "2026-10-01", "2026-10-15"]],
    ["frequency", { frequency: "biweekly" as const }, ["2026-09-01", "2026-10-01", "2026-10-13"]],
  ])("keeps generated_through when %s changes, so the new schedule starts after it", async (_field, change, dates) => {
    const result = await saveRecurringRule(db, rule, "2026-10-19");
    if (!result.ok) throw new Error("save failed");

    await saveRecurringRule(db, { ...rule, ...change, id: result.id }, "2026-10-19");

    expect(row("recurring_rules", result.id)).toMatchObject({ generated_through: dates[dates.length - 1] });
    expect(occurrenceDatesOf(result.id)).toEqual(dates);
  });

  it("does not backfill past dates when a long-running monthly rule becomes weekly", async () => {
    const monthly = { ...rule, start_date: "2025-01-01" };
    const result = await saveRecurringRule(db, monthly, "2026-10-19");
    if (!result.ok) throw new Error("save failed");
    expect(occurrenceDatesOf(result.id)).toHaveLength(22);

    await saveRecurringRule(db, { ...monthly, id: result.id, frequency: "weekly" }, "2026-10-19");

    // Only the weekly dates after 2026-10-01 (generated_through) and up to today.
    // 2025-01-01 is a Wednesday, so the weeks fall on 10-07 and 10-14.
    expect(occurrenceDatesOf(result.id)).toHaveLength(24);
    expect(occurrenceDatesOf(result.id).slice(-3)).toEqual(["2026-10-01", "2026-10-07", "2026-10-14"]);
  });

  it("rejects an end date before the start date", async () => {
    expect(await saveRecurringRule(db, { ...rule, end_date: "2026-08-31" }, "2026-10-19")).toEqual({
      ok: false,
      errors: [{ field: "end_date", code: "out_of_range" }],
    });
  });
});

describe("saveCategoryBudget", () => {
  function budgetRows(categoryId: string, period: string) {
    return sqlite
      .prepare("SELECT * FROM budgets WHERE category_id = ? AND period = ?")
      .all(categoryId, period) as Record<string, unknown>[];
  }

  it("inserts a budget for an expense category", async () => {
    const result = await saveCategoryBudget(db, "food", "monthly", 50000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = budgetRows("food", "monthly");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.id, user_id: "u1", category_id: "food", period: "monthly", amount_minor: 50000 });
  });

  it("updates the existing budget", async () => {
    const first = await saveCategoryBudget(db, "food", "monthly", 50000);
    if (!first.ok) throw new Error("first save failed");
    const second = await saveCategoryBudget(db, "food", "monthly", 45000);

    expect(second).toEqual({ ok: true, id: first.id });
    const rows = budgetRows("food", "monthly");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount_minor: 45000 });
  });

  it("keeps budgets of other periods", async () => {
    sqlite
      .prepare("INSERT INTO budgets (id, user_id, category_id, period, amount_minor) VALUES (?, ?, ?, ?, ?)")
      .run("b-weekly", "u1", "food", "weekly", 10000);

    await saveCategoryBudget(db, "food", "monthly", 50000);

    expect(budgetRows("food", "weekly")).toHaveLength(1);
    expect(budgetRows("food", "monthly")).toHaveLength(1);
  });

  it("deletes the budget for null", async () => {
    const first = await saveCategoryBudget(db, "food", "monthly", 50000);
    if (!first.ok) throw new Error("first save failed");

    const result = await saveCategoryBudget(db, "food", "monthly", null);

    expect(result).toEqual({ ok: true, id: first.id });
    expect(budgetRows("food", "monthly")).toHaveLength(0);
  });

  it("does nothing for null with no budget", async () => {
    const result = await saveCategoryBudget(db, "food", "monthly", null);

    expect(result).toEqual({ ok: true, id: "" });
    expect(budgetRows("food", "monthly")).toHaveLength(0);
  });

  it("rejects an income category", async () => {
    const result = await saveCategoryBudget(db, "salary", "monthly", 50000);

    expect(result).toEqual({ ok: false, errors: [{ field: "category_id", code: "invalid" }] });
    expect(budgetRows("salary", "monthly")).toHaveLength(0);
  });

  it("deletes a budget even after the category becomes income", async () => {
    await saveCategoryBudget(db, "food", "monthly", 50000);
    sqlite.prepare("UPDATE categories SET type = 'income' WHERE id = 'food'").run();

    const result = await saveCategoryBudget(db, "food", "monthly", null);

    expect(result.ok).toBe(true);
    expect(budgetRows("food", "monthly")).toHaveLength(0);
  });

  it.each([0, 1.5, MAX_AMOUNT_MINOR + 1])("rejects the out-of-range amount %p", async (amount) => {
    const result = await saveCategoryBudget(db, "food", "monthly", amount);

    expect(result).toEqual({ ok: false, errors: [{ field: "amount_minor", code: "out_of_range" }] });
    expect(budgetRows("food", "monthly")).toHaveLength(0);
  });

  it("does not touch the overall budget", async () => {
    sqlite
      .prepare("INSERT INTO budgets (id, user_id, category_id, period, amount_minor) VALUES (?, ?, ?, ?, ?)")
      .run("b-overall", "u1", null, "monthly", 200000);

    await saveCategoryBudget(db, "food", "monthly", 50000);

    expect(row("budgets", "b-overall")).toMatchObject({ category_id: null, amount_minor: 200000 });
  });
});

describe("updateSettings", () => {
  it("updates the one settings row and stores booleans as 0 or 1", async () => {
    await updateSettings(db, { hide_future: true, time_period: "weekly" });

    expect(row("user_settings", "s1")).toMatchObject({ hide_future: 1, time_period: "weekly", carry_over: 1 });
  });

  it("updates only the given columns", async () => {
    const spy = jest.spyOn(db, "execute");

    await updateSettings(db, { carry_over: false });

    expect(updateStatements(spy)).toEqual(["UPDATE user_settings SET carry_over = ? WHERE id = ?"]);
  });
});
