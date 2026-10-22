import { createTestDatabase, loadFixture, type TestDatabase } from "../../test/sqlite";
import type { PeriodSettings } from "../domain/period";
import {
  budgetProgress,
  carryOver,
  cashFlowSeries,
  categoryTotals,
  periodTotals,
  transactionList,
  type SqlQuery,
} from "./queries";

const october = { start: "2026-10-01", end: "2026-10-31" };
const today = "2026-10-19";
const settings: PeriodSettings = { week_start_day: 1, month_start_day: 1, year_start_month: 1 };

const userSettings = {
  id: "s1",
  user_id: "u1",
  currency_code: "EUR",
  time_period: "monthly",
  ...settings,
  budget_mode: false,
  carry_over: true,
  hide_future: false,
  show_note: true,
  theme: "system",
  summary_font: "mono",
  icon_style: "filled",
};

const accounts = [
  { id: "wallet", user_id: "u1", name: "Wallet", color: "#000000", sort_order: 0 },
  { id: "bank", user_id: "u1", name: "Bank", color: "#000000", sort_order: 1 },
  { id: "empty", user_id: "u1", name: "Empty", color: "#000000", sort_order: 2 },
  {
    id: "closed",
    user_id: "u1",
    name: "Closed",
    color: "#000000",
    sort_order: 3,
    archived_at: "2026-01-01T00:00:00Z",
  },
];

const categories = [
  { id: "food", user_id: "u1", type: "expense", name: "Groceries", icon: "cart", color: "#000000", sort_order: 0 },
  { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "cash", color: "#000000", sort_order: 1 },
  {
    id: "old",
    user_id: "u1",
    type: "expense",
    name: "Old hobby",
    icon: "star",
    color: "#000000",
    sort_order: 2,
    archived_at: "2026-01-01T00:00:00Z",
  },
];

let seq = 0;
function tx(fields: Record<string, unknown>) {
  seq += 1;
  return {
    id: `t${String(seq).padStart(6, "0")}`,
    user_id: "u1",
    currency_code: "EUR",
    name: "",
    source: "manual",
    ...fields,
  };
}

const transactions = [
  // Before October: carry over.
  tx({ type: "income", amount_minor: 200000, date: "2026-08-01", account_id: "bank", category_id: "salary", name: "Pay" }),
  tx({ type: "transfer", amount_minor: 50000, date: "2026-08-02", account_id: "bank", to_account_id: "wallet" }),
  tx({ type: "expense", amount_minor: 7000, date: "2026-09-30", account_id: "wallet", category_id: "food", name: "Market" }),
  tx({ type: "expense", amount_minor: 900, date: "2026-09-15", account_id: "closed", category_id: "food" }),
  // October.
  tx({ type: "income", amount_minor: 100000, date: "2026-10-01", account_id: "bank", category_id: "salary", name: "Pay" }),
  tx({ type: "expense", amount_minor: 20000, date: "2026-10-05", account_id: "wallet", category_id: "food", name: "Lidl", note: "weekly SHOP" }),
  tx({ type: "expense", amount_minor: 3000, date: "2026-10-06", account_id: "wallet", category_id: "food", name: "Bakery" }),
  tx({ type: "expense", amount_minor: 5000, date: "2026-10-06", account_id: "wallet", category_id: "old", name: "Paint" }),
  tx({ type: "transfer", amount_minor: 30000, date: "2026-10-07", account_id: "bank", to_account_id: "wallet", name: "Top up" }),
  // After today.
  tx({ type: "expense", amount_minor: 1000, date: "2026-10-25", account_id: "wallet", category_id: "food", name: "Future shop" }),
  // November.
  tx({ type: "expense", amount_minor: 4000, date: "2026-11-02", account_id: "wallet", category_id: "food" }),
];

function all<T>(db: TestDatabase, query: SqlQuery): T[] {
  return db.prepare(query.sql).all(...query.parameters) as T[];
}

function first<T>(db: TestDatabase, query: SqlQuery): T | undefined {
  return all<T>(db, query)[0];
}

function setSettings(db: TestDatabase, values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) {
    db.prepare(`UPDATE user_settings SET ${key} = ?`).run(value);
  }
}

let db: TestDatabase;

function idOf(name: string): string {
  return (db.prepare("SELECT id FROM transactions WHERE name = ? AND date >= '2026-10-01'").get([name]) as { id: string }).id;
}

beforeEach(() => {
  db = createTestDatabase();
  loadFixture(db, { user_settings: [userSettings], accounts, categories, transactions });
});

afterEach(() => db.close());

describe("periodTotals", () => {
  it("leaves out transfers for all accounts", () => {
    expect(first(db, periodTotals(october, null, today))).toEqual({
      income: 100000,
      expense: 29000,
      transfer_in: 0,
      transfer_out: 0,
      balance: 71000,
    });
  });

  it("shows transfers in and out separately for one account", () => {
    expect(first(db, periodTotals(october, "wallet", today))).toEqual({
      income: 0,
      expense: 29000,
      transfer_in: 30000,
      transfer_out: 0,
      balance: 1000,
    });
    expect(first(db, periodTotals(october, "bank", today))).toEqual({
      income: 100000,
      expense: 0,
      transfer_in: 0,
      transfer_out: 30000,
      balance: 70000,
    });
  });

  it("applies the category, type and search filters of the list", () => {
    expect(first(db, periodTotals(october, null, today, { categoryId: "food" }))).toMatchObject({ income: 0, expense: 24000 });
    expect(first(db, periodTotals(october, null, today, { type: "income" }))).toMatchObject({ income: 100000, expense: 0 });
    expect(first(db, periodTotals(october, null, today, { type: "transfer" }))).toMatchObject({ income: 0, expense: 0 });
    expect(first(db, periodTotals(october, null, today, { search: " shop " }))).toMatchObject({ income: 0, expense: 21000 });
    expect(first(db, periodTotals(october, "bank", today, { categoryId: "food" }))).toMatchObject({ income: 0, expense: 0 });
  });

  it("leaves out the excluded ids (pending deletes)", () => {
    const lidl = idOf("Lidl");
    expect(first(db, periodTotals(october, "wallet", today, { excludeIds: [lidl, idOf("Top up")] }))).toEqual({
      income: 0,
      expense: 9000,
      transfer_in: 0,
      transfer_out: 0,
      balance: -9000,
    });
    expect(first(db, periodTotals(october, null, today, { excludeIds: [] }))).toMatchObject({ expense: 29000 });
  });

  it("matches the income and expense rows of transactionList", () => {
    const cases: [string | null, { categoryId?: string; type?: "expense" | "income"; search?: string }][] = [
      [null, {}],
      ["wallet", {}],
      [null, { categoryId: "food" }],
      ["wallet", { categoryId: "old" }],
      [null, { type: "expense" }],
      [null, { search: "pay" }],
      ["wallet", { categoryId: "food", type: "expense", search: "lidl" }],
    ];
    for (const [accountId, filters] of cases) {
      const rows = all<ListRow>(
        db,
        transactionList(october, { accountId, categoryId: filters.categoryId, type: filters.type }, "date", filters.search ?? "", today),
      ).filter((r) => r.kind === "transaction");
      const sum = (type: string) => rows.filter((r) => r.type === type).reduce((total, r) => total + r.amount_minor, 0);
      expect(first(db, periodTotals(october, accountId, today, filters))).toMatchObject({
        income: sum("income"),
        expense: sum("expense"),
      });
    }
  });
});

describe("categoryTotals", () => {
  it("sorts by amount and keeps the names of archived categories", () => {
    const rows = all<{ category_id: string; name: string; total: number }>(
      db,
      categoryTotals(october, null, "expense", today),
    );
    expect(rows.map((r) => [r.category_id, r.name, r.total])).toEqual([
      ["food", "Groceries", 24000],
      ["old", "Old hobby", 5000],
    ]);
  });

  it("leaves out the excluded ids (pending deletes)", () => {
    expect(all(db, categoryTotals(october, null, "expense", today, [idOf("Lidl"), idOf("Paint")]))).toMatchObject([
      { category_id: "food", total: 4000 },
    ]);
  });

  it("filters by type and account", () => {
    expect(all(db, categoryTotals(october, null, "income", today))).toMatchObject([
      { category_id: "salary", total: 100000 },
    ]);
    expect(all(db, categoryTotals(october, "bank", "expense", today))).toEqual([]);
  });
});

describe("carryOver", () => {
  it("returns one balance per account, also zero and also archived", () => {
    expect(all(db, carryOver(october.start, null, today))).toEqual([
      { account_id: "wallet", account_name: "Wallet", balance: 43000 },
      { account_id: "bank", account_name: "Bank", balance: 150000 },
      { account_id: "empty", account_name: "Empty", balance: 0 },
      { account_id: "closed", account_name: "Closed", balance: -900 },
    ]);
  });

  it("keeps the All Accounts balance when an account is archived", () => {
    const balance = () => {
      const carry = all<{ balance: number }>(db, carryOver("2026-10-07", null, today)).reduce((sum, r) => sum + r.balance, 0);
      return carry + first<{ balance: number }>(db, periodTotals({ start: "2026-10-07", end: "2026-10-31" }, null, today))!.balance;
    };
    const before = balance();
    db.prepare(`UPDATE accounts SET archived_at = '2026-10-20T00:00:00Z' WHERE id = 'wallet'`).run();
    expect(balance()).toBe(before);
  });

  it("returns the balance of one archived account", () => {
    expect(all(db, carryOver(october.start, ["closed"], today))).toEqual([
      { account_id: "closed", account_name: "Closed", balance: -900 },
    ]);
  });

  it("returns only the given accounts", () => {
    expect(all(db, carryOver("2026-11-01", ["wallet"], today))).toEqual([
      { account_id: "wallet", account_name: "Wallet", balance: 44000 },
    ]);
  });

  it("adds the opening balance of the account", () => {
    db.prepare(`UPDATE accounts SET opening_balance_minor = 10000 WHERE id = 'wallet'`).run();
    expect(all(db, carryOver(october.start, ["wallet"], today))).toEqual([
      { account_id: "wallet", account_name: "Wallet", balance: 53000 },
    ]);
  });

  it("shows an opening balance for an account with no rows", () => {
    db.prepare(`UPDATE accounts SET opening_balance_minor = -2500 WHERE id = 'empty'`).run();
    expect(all(db, carryOver(october.start, ["empty"], today))).toEqual([
      { account_id: "empty", account_name: "Empty", balance: -2500 },
    ]);
  });
});

describe("hide_future", () => {
  beforeEach(() => setSettings(db, { hide_future: 1 }));

  it("leaves out rows after today from totals", () => {
    expect(first(db, periodTotals(october, null, today))).toMatchObject({ expense: 28000 });
    expect(all(db, categoryTotals(october, null, "expense", today))).toMatchObject([
      { category_id: "food", total: 23000 },
      { category_id: "old", total: 5000 },
    ]);
    expect(all(db, carryOver("2026-11-01", ["wallet"], today))).toMatchObject([{ balance: 45000 }]);
  });

  it("leaves out rows after today from the list", () => {
    const names = all<{ name: string }>(db, transactionList(october, {}, "date", "", today)).map((r) => r.name);
    expect(names).not.toContain("Future shop");
  });
});

type ListRow = { id: string; kind: string; name: string; date: string; type: string; amount_minor: number; account_id: string };

describe("transactionList", () => {
  it("sorts by date, newest first, with Carry Over rows at range.start", () => {
    const rows = all<ListRow>(db, transactionList(october, {}, "date", "", today));
    expect(rows.map((r) => [r.kind, r.date, r.name])).toEqual([
      ["transaction", "2026-10-25", "Future shop"],
      ["transaction", "2026-10-07", "Top up"],
      ["transaction", "2026-10-06", "Bakery"],
      ["transaction", "2026-10-06", "Paint"],
      ["transaction", "2026-10-05", "Lidl"],
      ["transaction", "2026-10-01", "Pay"],
      ["carryOver", "2026-10-01", "Carry Over"],
      ["carryOver", "2026-10-01", "Carry Over"],
      ["carryOver", "2026-10-01", "Carry Over"],
    ]);
    expect(rows.filter((r) => r.kind === "carryOver")).toMatchObject([
      { account_id: "bank", type: "income", amount_minor: 150000 },
      { account_id: "closed", type: "expense", amount_minor: 900 },
      { account_id: "wallet", type: "income", amount_minor: 43000 },
    ]);
  });

  it("has Carry Over rows that add up to carryOver, archived accounts too", () => {
    for (const accountId of [null, "wallet", "closed"]) {
      const rows = all<ListRow>(db, transactionList(october, { accountId }, "date", "", today));
      const listed = rows
        .filter((r) => r.kind === "carryOver")
        .reduce((sum, r) => sum + (r.type === "expense" ? -r.amount_minor : r.amount_minor), 0);
      const carry = all<{ balance: number }>(db, carryOver(october.start, accountId === null ? null : [accountId], today));
      expect(listed).toBe(carry.reduce((sum, r) => sum + r.balance, 0));
    }
  });

  it("lists the rows of an archived account", () => {
    db.prepare(`UPDATE accounts SET archived_at = '2026-10-20T00:00:00Z' WHERE id = 'bank'`).run();
    const rows = all<ListRow>(db, transactionList(october, { accountId: "bank" }, "date", "", today));
    expect(rows.map((r) => [r.kind, r.name, r.amount_minor])).toEqual([
      ["transaction", "Top up", 30000],
      ["transaction", "Pay", 100000],
      ["carryOver", "Carry Over", 150000],
    ]);
  });

  it("shows a negative Carry Over as an expense", () => {
    loadFixture(db, {
      transactions: [tx({ type: "expense", amount_minor: 99000, date: "2026-09-01", account_id: "wallet", category_id: "food" })],
    });
    const rows = all<ListRow>(db, transactionList(october, { accountId: "wallet" }, "date", "", today));
    expect(rows.filter((r) => r.kind === "carryOver")).toMatchObject([
      { account_id: "wallet", type: "expense", amount_minor: 56000 },
    ]);
  });

  it("shows a Carry Over row for an account with only an opening balance", () => {
    db.prepare(`UPDATE accounts SET opening_balance_minor = -2500 WHERE id = 'empty'`).run();
    const rows = all<ListRow>(db, transactionList(october, {}, "date", "", today));
    expect(rows.filter((r) => r.kind === "carryOver" && r.account_id === "empty")).toMatchObject([
      { kind: "carryOver", account_id: "empty", type: "expense", amount_minor: 2500 },
    ]);
  });

  it("has no Carry Over rows when carry_over is off", () => {
    setSettings(db, { carry_over: 0 });
    const rows = all<ListRow>(db, transactionList(october, {}, "date", "", today));
    expect(rows.some((r) => r.kind === "carryOver")).toBe(false);
  });

  it("filters by account, also transfers into the account", () => {
    const rows = all<ListRow>(db, transactionList(october, { accountId: "bank" }, "date", "", today));
    expect(rows.map((r) => [r.kind, r.name])).toEqual([
      ["transaction", "Top up"],
      ["transaction", "Pay"],
      ["carryOver", "Carry Over"],
    ]);
  });

  it("filters by category and type", () => {
    const byCategory = all<ListRow>(db, transactionList(october, { categoryId: "old" }, "date", "", today));
    expect(byCategory.map((r) => r.name)).toEqual(["Paint"]);
    const byType = all<ListRow>(db, transactionList(october, { type: "transfer" }, "date", "", today));
    expect(byType.map((r) => r.name)).toEqual(["Top up"]);
  });

  it("searches name and note case-insensitively", () => {
    const byName = all<ListRow>(db, transactionList(october, {}, "date", "LIDL", today));
    expect(byName.map((r) => r.name)).toEqual(["Lidl"]);
    const byNote = all<ListRow>(db, transactionList(october, {}, "date", "shop", today));
    expect(byNote.map((r) => r.name)).toEqual(["Future shop", "Lidl"]);
  });

  it("searches non-ASCII names in any letter case", () => {
    db.prepare(
      `INSERT INTO transactions (id, user_id, type, amount_minor, currency_code, date, name, account_id, source)
       VALUES ('cafe', 'u1', 'expense', 100, 'EUR', '2026-10-05', 'Кафе Звезда', 'wallet', 'manual')`,
    ).run();
    for (const search of ["кафе", "КАФЕ", "звезда", "кафе звезда"]) {
      const rows = all<ListRow>(db, transactionList(october, {}, "date", search, today));
      expect(rows.map((r) => r.name)).toEqual(["Кафе Звезда"]);
    }
  });

  it("treats % and _ in the search as plain text", () => {
    expect(all(db, transactionList(october, {}, "date", "%", today))).toEqual([]);
    expect(all(db, transactionList(october, {}, "date", "_", today))).toEqual([]);
  });

  it("sorts by name and by amount", () => {
    const filters = { accountId: "wallet" };
    const byName = all<ListRow>(db, transactionList(october, filters, "name", "", today));
    expect(byName.map((r) => r.name)).toEqual(["Carry Over", "Bakery", "Future shop", "Lidl", "Paint", "Top up"]);
    const byAmount = all<ListRow>(db, transactionList(october, filters, "amount", "", today));
    expect(byAmount.map((r) => r.amount_minor)).toEqual([43000, 30000, 20000, 5000, 3000, 1000]);
  });

  it("puts Carry Over rows first when sorted by amount or name", () => {
    const byAmount = all<ListRow>(db, transactionList(october, {}, "amount", "", today));
    expect(byAmount.map((r) => [r.kind, r.amount_minor])).toEqual([
      ["carryOver", 150000],
      ["carryOver", 43000],
      ["carryOver", 900],
      ["transaction", 100000],
      ["transaction", 30000],
      ["transaction", 20000],
      ["transaction", 5000],
      ["transaction", 3000],
      ["transaction", 1000],
    ]);
    const byName = all<ListRow>(db, transactionList(october, {}, "name", "", today));
    expect(byName.slice(0, 4).map((r) => r.kind)).toEqual(["carryOver", "carryOver", "carryOver", "transaction"]);
  });

  it("returns one page", () => {
    const page = all<ListRow>(db, transactionList(october, {}, "date", "", today, { limit: 2, offset: 1 }));
    expect(page.map((r) => r.name)).toEqual(["Top up", "Bakery"]);
  });
});

describe("budgetProgress", () => {
  const budgets = [
    { id: "b-month", user_id: "u1", category_id: null, period: "monthly", amount_minor: 50000 },
    { id: "b-week", user_id: "u1", category_id: null, period: "weekly", amount_minor: 10000 },
    { id: "b-food", user_id: "u1", category_id: "food", period: "monthly", amount_minor: 20000 },
  ];

  it("is null when budget_mode is off", () => {
    loadFixture(db, { budgets });
    expect(first(db, budgetProgress(october, today))).toBeUndefined();
  });

  it("is null when no overall budget exists for the period", () => {
    setSettings(db, { budget_mode: 1 });
    loadFixture(db, { budgets: [budgets[2]] });
    expect(first(db, budgetProgress(october, today))).toBeUndefined();
  });

  it("returns the overall budget for the setting's period and the spent amount", () => {
    setSettings(db, { budget_mode: 1 });
    loadFixture(db, { budgets });
    expect(first(db, budgetProgress(october, today))).toEqual({
      budget_id: "b-month",
      period: "monthly",
      amount_minor: 50000,
      spent_minor: 29000,
    });
  });
});

describe("cashFlowSeries", () => {
  it("returns income and expense for the last periods, oldest first, without transfers", () => {
    expect(all(db, cashFlowSeries(october, "monthly", settings, 3, today))).toEqual([
      { start: "2026-08-01", end: "2026-08-31", income: 200000, expense: 0 },
      { start: "2026-09-01", end: "2026-09-30", income: 0, expense: 7900 },
      { start: "2026-10-01", end: "2026-10-31", income: 100000, expense: 29000 },
    ]);
  });
});

describe("performance with 50,000 transactions", () => {
  beforeEach(() => {
    const rows = [];
    for (let i = 0; i < 50000; i++) {
      const day = new Date(Date.UTC(2023, 0, 1) + (i % 1400) * 86400000).toISOString().slice(0, 10);
      const type = i % 10 === 0 ? "income" : i % 10 === 1 ? "transfer" : "expense";
      rows.push(
        tx({
          type,
          amount_minor: 100 + (i % 5000),
          date: day,
          account_id: i % 2 ? "wallet" : "bank",
          to_account_id: type === "transfer" ? (i % 2 ? "bank" : "wallet") : null,
          category_id: type === "income" ? "salary" : type === "expense" ? "food" : null,
          name: `Row ${i}`,
        }),
      );
    }
    loadFixture(db, { transactions: rows });
    db.exec("ANALYZE");
  });

  function timed(run: () => unknown): number {
    run();
    const started = performance.now();
    run();
    return performance.now() - started;
  }

  it("runs periodTotals in under 50 ms", () => {
    expect(timed(() => first(db, periodTotals(october, null, today)))).toBeLessThan(50);
    expect(timed(() => first(db, periodTotals(october, "wallet", today)))).toBeLessThan(50);
  });

  it("runs a 100-row transactionList page in under 50 ms", () => {
    const page = { limit: 100, offset: 0 };
    let rows: unknown[] = [];
    expect(timed(() => (rows = all(db, transactionList(october, {}, "date", "", today, page))))).toBeLessThan(50);
    expect(rows).toHaveLength(100);
  });
});
