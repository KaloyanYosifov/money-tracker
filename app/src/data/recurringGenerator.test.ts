import { asyncDatabase, createTestDatabase, loadFixture, type AsyncTestDatabase, type TestDatabase } from "../../test/sqlite";
import { occurrenceId } from "../domain/ids";
import { generateDue } from "./recurringGenerator";

const fixture = {
  user_settings: [{ id: "s1", user_id: "u1", currency_code: "EUR" }],
  accounts: [
    { id: "wallet", user_id: "u1", name: "Wallet", color: "#000000", sort_order: 0 },
    { id: "bank", user_id: "u1", name: "Bank", color: "#000000", sort_order: 1 },
  ],
  categories: [
    { id: "home", user_id: "u1", type: "expense", name: "Rent", icon: "home", color: "#000000", sort_order: 0 },
  ],
  recurring_rules: [
    {
      id: "rent",
      user_id: "u1",
      type: "expense",
      amount_minor: 80000,
      name: "Rent",
      category_id: "home",
      account_id: "bank",
      note: "flat",
      frequency: "monthly",
      start_date: "2026-08-01",
    },
    {
      id: "savings",
      user_id: "u1",
      type: "transfer",
      amount_minor: 5000,
      name: "Savings",
      account_id: "bank",
      to_account_id: "wallet",
      frequency: "weekly",
      start_date: "2026-10-05",
      end_date: "2026-10-12",
    },
  ],
};

let sqlite: TestDatabase;
let db: AsyncTestDatabase;

beforeEach(() => {
  sqlite = createTestDatabase();
  loadFixture(sqlite, fixture);
  db = asyncDatabase(sqlite);
});

function transactions() {
  return sqlite.prepare("SELECT * FROM transactions ORDER BY date, id").all() as Record<string, unknown>[];
}

describe("generateDue", () => {
  it("inserts one transaction per due occurrence", async () => {
    const inserted = await generateDue(db, "2026-10-19");

    expect(inserted).toBe(5);
    const rows = transactions();
    expect(rows.map((r) => [r.recurring_rule_id, r.date])).toEqual([
      ["rent", "2026-08-01"],
      ["rent", "2026-09-01"],
      ["rent", "2026-10-01"],
      ["savings", "2026-10-05"],
      ["savings", "2026-10-12"],
    ]);
    expect(rows.find((r) => r.date === "2026-09-01")).toEqual({
      id: occurrenceId("rent", "2026-09-01"),
      user_id: "u1",
      type: "expense",
      amount_minor: 80000,
      currency_code: "EUR",
      date: "2026-09-01",
      name: "Rent",
      category_id: "home",
      account_id: "bank",
      to_account_id: null,
      note: "flat",
      recurring_rule_id: "rent",
      source: "recurring",
      import_batch_id: null,
      external_id: null,
      created_at: null,
      updated_at: null,
    });
    expect(rows.find((r) => r.date === "2026-10-12")).toMatchObject({
      id: occurrenceId("savings", "2026-10-12"),
      type: "transfer",
      category_id: null,
      to_account_id: "wallet",
    });
  });

  it("inserts nothing on a second run", async () => {
    await generateDue(db, "2026-10-19");

    expect(await generateDue(db, "2026-10-19")).toBe(0);
    expect(transactions()).toHaveLength(5);
  });

  it("never overwrites an existing row with the occurrence ID", async () => {
    const id = occurrenceId("rent", "2026-09-01");
    loadFixture(sqlite, {
      transactions: [
        {
          id,
          user_id: "u1",
          type: "expense",
          amount_minor: 81234,
          currency_code: "EUR",
          date: "2026-09-02",
          name: "Rent, paid late",
          category_id: "home",
          account_id: "bank",
          recurring_rule_id: "rent",
          source: "recurring",
        },
      ],
    });

    expect(await generateDue(db, "2026-10-19")).toBe(4);
    expect(sqlite.prepare("SELECT amount_minor, date, name FROM transactions WHERE id = ?").get(id)).toEqual({
      amount_minor: 81234,
      date: "2026-09-02",
      name: "Rent, paid late",
    });
  });
});
