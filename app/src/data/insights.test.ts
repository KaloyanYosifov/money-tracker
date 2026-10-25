import { asyncDatabase, createTestDatabase, loadFixture, type AsyncTestDatabase, type TestDatabase } from "../../test/sqlite";
import { acceptBudgetCard, acceptRecurringCard, askQuestion, dismissCard, parseAction, type InsightCard } from "./insights";

const fixture = {
  user_settings: [
    {
      id: "s1",
      user_id: "u1",
      currency_code: "EUR",
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
      insights_enabled: true,
    },
  ],
  accounts: [{ id: "wallet", user_id: "u1", name: "Wallet", color: "#000000", sort_order: 0 }],
  categories: [
    { id: "food", user_id: "u1", type: "expense", name: "Groceries", icon: "cart", color: "#000000", sort_order: 0 },
    { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "coins", color: "#000000", sort_order: 1 },
    {
      id: "old",
      user_id: "u1",
      type: "expense",
      name: "Old",
      icon: "tag",
      color: "#000000",
      sort_order: 2,
      archived_at: "2026-09-01T00:00:00Z",
    },
  ],
};

function card(id: string, kind: InsightCard["kind"], action: unknown): InsightCard {
  return {
    id,
    user_id: "u1",
    kind,
    title: "A suggestion",
    body: "Some text",
    fingerprint: `fp-${id}`,
    status: "open",
    action: action === null ? null : JSON.stringify(action),
    created_at: "2026-10-20T06:00:00Z",
    updated_at: "2026-10-20T06:00:00Z",
  };
}

let sqlite: TestDatabase;
let db: AsyncTestDatabase;

function load(cards: InsightCard[]) {
  loadFixture(sqlite, { insights: cards as unknown as Record<string, unknown>[] });
}

function cardStatus(id: string) {
  return (sqlite.prepare("SELECT status FROM insights WHERE id = ?").get(id) as { status: string }).status;
}

beforeEach(() => {
  sqlite = createTestDatabase();
  loadFixture(sqlite, fixture);
  db = asyncDatabase(sqlite);
});

describe("parseAction", () => {
  it("reads the JSON action of a card", () => {
    expect(parseAction(card("c1", "budget", { category_id: "food", amount_minor: 30000 }))).toEqual({
      category_id: "food",
      amount_minor: 30000,
    });
  });

  it("gives null for a tip, bad JSON or a wrong shape", () => {
    expect(parseAction(card("c1", "tip", null))).toBeNull();
    expect(parseAction({ ...card("c1", "budget", null), action: "{not json" })).toBeNull();
    expect(parseAction(card("c1", "budget", { category_id: "food" }))).toBeNull();
    expect(parseAction(card("c1", "recurring_rule", { category_id: "food", amount_minor: 100 }))).toBeNull();
  });
});

describe("acceptBudgetCard", () => {
  it("writes the category budget and accepts the card in one transaction", async () => {
    const budget = card("c1", "budget", { category_id: "food", amount_minor: 30000 });
    load([budget]);
    const transaction = jest.spyOn(db, "writeTransaction");

    const result = await acceptBudgetCard(db, budget);

    expect(result.ok).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT user_id, category_id, period, amount_minor FROM budgets").all()).toEqual([
      { user_id: "u1", category_id: "food", period: "monthly", amount_minor: 30000 },
    ]);
    expect(cardStatus("c1")).toBe("accepted");
  });

  it("saves the amount that the user changed in the sheet", async () => {
    const budget = card("c1", "budget", { category_id: "food", amount_minor: 30000 });
    load([budget]);

    await acceptBudgetCard(db, budget, 25000);

    expect(sqlite.prepare("SELECT amount_minor FROM budgets").get()).toEqual({ amount_minor: 25000 });
  });

  it("keeps the card open when the amount is not valid", async () => {
    const budget = card("c1", "budget", { category_id: "food", amount_minor: 30000 });
    load([budget]);

    const result = await acceptBudgetCard(db, budget, 0);

    expect(result).toEqual({ ok: false, errors: [{ field: "amount_minor", code: "out_of_range" }] });
    expect(cardStatus("c1")).toBe("open");
    expect(sqlite.prepare("SELECT * FROM budgets").all()).toEqual([]);
  });

  it.each([
    ["an archived category", "old"],
    ["an income category", "salary"],
    ["a deleted category", "gone"],
  ])("dismisses the card as out of date for %s", async (_name, categoryId) => {
    const budget = card("c1", "budget", { category_id: categoryId, amount_minor: 30000 });
    load([budget]);

    const result = await acceptBudgetCard(db, budget);

    expect(result).toEqual({ ok: false, outOfDate: true });
    expect(cardStatus("c1")).toBe("dismissed");
    expect(sqlite.prepare("SELECT * FROM budgets").all()).toEqual([]);
  });
});

describe("acceptRecurringCard", () => {
  const ruleAction = {
    type: "expense",
    category_id: "food",
    account_id: "wallet",
    amount_minor: 1500,
    frequency: "monthly",
    start_date: "2026-09-05",
    name: "Gym",
  };

  it("saves the rule, accepts the card and generates the due occurrences", async () => {
    const rule = card("c2", "recurring_rule", ruleAction);
    load([rule]);

    const result = await acceptRecurringCard(db, rule, "2026-10-24");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sqlite.prepare("SELECT * FROM recurring_rules").all()).toEqual([
      expect.objectContaining({
        id: result.id,
        user_id: "u1",
        type: "expense",
        category_id: "food",
        account_id: "wallet",
        amount_minor: 1500,
        frequency: "monthly",
        start_date: "2026-09-05",
        name: "Gym",
        generated_through: "2026-10-05",
      }),
    ]);
    expect(cardStatus("c2")).toBe("accepted");
    expect(sqlite.prepare("SELECT date FROM transactions WHERE recurring_rule_id = ? ORDER BY date").all(result.id)).toEqual([
      { date: "2026-09-05" },
      { date: "2026-10-05" },
    ]);
  });

  it("saves the values that the user changed in the sheet", async () => {
    const rule = card("c2", "recurring_rule", { ...ruleAction, account_id: undefined });
    load([rule]);

    const result = await acceptRecurringCard(db, rule, "2026-10-24", { account_id: "wallet", amount_minor: 2000 });

    expect(result.ok).toBe(true);
    expect(sqlite.prepare("SELECT account_id, amount_minor FROM recurring_rules").get()).toEqual({
      account_id: "wallet",
      amount_minor: 2000,
    });
  });

  it("keeps the card open when the rule is not valid", async () => {
    const rule = card("c2", "recurring_rule", { ...ruleAction, account_id: undefined });
    load([rule]);

    const result = await acceptRecurringCard(db, rule, "2026-10-24");

    expect(result).toEqual({ ok: false, errors: [{ field: "account_id", code: "required" }] });
    expect(cardStatus("c2")).toBe("open");
    expect(sqlite.prepare("SELECT * FROM recurring_rules").all()).toEqual([]);
  });

  it("dismisses the card as out of date when the category is archived or has another type", async () => {
    const archived = card("c2", "recurring_rule", { ...ruleAction, category_id: "old" });
    const wrongType = card("c3", "recurring_rule", { ...ruleAction, category_id: "salary" });
    load([archived, wrongType]);

    expect(await acceptRecurringCard(db, archived, "2026-10-24")).toEqual({ ok: false, outOfDate: true });
    expect(await acceptRecurringCard(db, wrongType, "2026-10-24")).toEqual({ ok: false, outOfDate: true });
    expect(cardStatus("c2")).toBe("dismissed");
    expect(cardStatus("c3")).toBe("dismissed");
    expect(sqlite.prepare("SELECT * FROM recurring_rules").all()).toEqual([]);
  });
});

describe("dismissCard", () => {
  it("sets the card status to dismissed", async () => {
    load([card("c1", "tip", null)]);

    await dismissCard(db, "c1");

    expect(cardStatus("c1")).toBe("dismissed");
  });
});

describe("askQuestion", () => {
  it("inserts a pending question with the trimmed text", async () => {
    const result = await askQuestion(db, "food", "  Why is this so high?  ");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sqlite.prepare("SELECT * FROM insight_questions").all()).toEqual([
      expect.objectContaining({
        id: result.id,
        user_id: "u1",
        category_id: "food",
        question: "Why is this so high?",
        status: "pending",
        answer: null,
        action: null,
      }),
    ]);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ["an empty text", "   ", "required"],
    ["a text over 500 characters", "x".repeat(501), "too_long"],
  ])("rejects %s", async (_name, text, code) => {
    const result = await askQuestion(db, "food", text);

    expect(result).toEqual({ ok: false, errors: [{ field: "question", code }] });
    expect(sqlite.prepare("SELECT * FROM insight_questions").all()).toEqual([]);
  });

  it("accepts a text of exactly 500 characters", async () => {
    expect((await askQuestion(db, "food", "x".repeat(500))).ok).toBe(true);
  });

  function addQuestions(count: number, status: string, createdAt: string | null) {
    const insert = sqlite.prepare(
      `INSERT INTO insight_questions (id, user_id, category_id, question, status, created_at)
       VALUES (?, 'u1', 'food', 'q', ?, ${createdAt ?? "NULL"})`,
    );
    for (let i = 0; i < count; i++) insert.run(`${status}-${createdAt}-${i}`, status);
  }

  it("rejects a question when 50 questions are from the last 24 hours", async () => {
    addQuestions(30, "answered", "datetime('now', '-1 hour')");
    addQuestions(20, "pending", null);

    const result = await askQuestion(db, "food", "One more?");

    expect(result).toEqual({
      ok: false,
      errors: [{ field: "question", code: "out_of_range", message: "You can ask 50 questions a day. Try again later." }],
    });
  });

  it("does not count failed questions or questions older than 24 hours", async () => {
    addQuestions(49, "answered", "datetime('now', '-25 hours')");
    addQuestions(10, "failed", "datetime('now', '-1 hour')");
    addQuestions(49, "answered", "datetime('now', '-1 hour')");

    expect((await askQuestion(db, "food", "One more?")).ok).toBe(true);
  });
});
