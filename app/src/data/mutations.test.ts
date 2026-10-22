import { asyncDatabase, createTestDatabase, loadFixture, type AsyncTestDatabase, type TestDatabase } from "../../test/sqlite";
import {
  archiveAccount,
  archiveCategory,
  deleteAccount,
  deleteCategory,
  restoreAccount,
  restoreCategory,
  saveAccount,
  saveCategory,
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

  it("rejects an end date before the start date", async () => {
    expect(await saveRecurringRule(db, { ...rule, end_date: "2026-08-31" }, "2026-10-19")).toEqual({
      ok: false,
      errors: [{ field: "end_date", code: "out_of_range" }],
    });
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
