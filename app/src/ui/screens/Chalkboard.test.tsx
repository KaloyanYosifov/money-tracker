import { StyleSheet } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import { UndoProvider } from "../../data/UndoProvider";
import { Chalkboard } from "./Chalkboard";

let mockDb: TestDatabase;

// The hooks run their SQL against the in-memory fixture database.
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) => ({
    data: mockDb.prepare(sql).all(parameters),
    isLoading: false,
  }),
}));

const october = { start: "2026-10-01", end: "2026-10-31" };

const userSettings = {
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
  theme: "light",
  summary_font: "mono",
  icon_style: "filled",
};

const accounts = [
  { id: "bank", user_id: "u1", name: "Bank", color: "#000000", sort_order: 0 },
  { id: "wallet", user_id: "u1", name: "Wallet", color: "#000000", sort_order: 1 },
];

const categories = [
  { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "cash", color: "#000000", sort_order: 0 },
  { id: "rent", user_id: "u1", type: "expense", name: "Rent", icon: "key", color: "#000000", sort_order: 1 },
  { id: "groceries", user_id: "u1", type: "expense", name: "Groceries", icon: "cart", color: "#000000", sort_order: 2 },
  { id: "shopping", user_id: "u1", type: "expense", name: "Shopping", icon: "tag", color: "#000000", sort_order: 3 },
];

let seq = 0;
function tx(fields: Record<string, unknown>) {
  seq += 1;
  return { id: `t${seq}`, user_id: "u1", currency_code: "EUR", name: "", source: "manual", ...fields };
}

const transactions = [
  // Before October: the carry over is 95,103.20 on Bank and 500.00 on Wallet.
  tx({ type: "income", amount_minor: 9560320, date: "2026-09-01", account_id: "bank", category_id: "salary" }),
  tx({ type: "transfer", amount_minor: 50000, date: "2026-09-02", account_id: "bank", to_account_id: "wallet" }),
  // October: expenses of 3,168.49 and one transfer.
  tx({ type: "expense", amount_minor: 115000, date: "2026-10-01", account_id: "bank", category_id: "rent" }),
  tx({ type: "expense", amount_minor: 155230, date: "2026-10-05", account_id: "bank", category_id: "groceries" }),
  tx({ type: "expense", amount_minor: 46619, date: "2026-10-06", account_id: "wallet", category_id: "shopping" }),
  tx({ type: "transfer", amount_minor: 10000, date: "2026-10-07", account_id: "bank", to_account_id: "wallet" }),
];

function load(settings: Partial<typeof userSettings> = {}, extra: Record<string, Record<string, unknown>[]> = {}) {
  mockDb = createTestDatabase();
  loadFixture(mockDb, {
    user_settings: [{ ...userSettings, ...settings }],
    accounts,
    categories,
    transactions,
    ...extra,
  });
}

function renderBoard(props: Partial<Parameters<typeof Chalkboard>[0]> = {}) {
  return render(
    <UndoProvider db={{ execute: jest.fn() }}>
      <Chalkboard period={october} locale="en-GB" onCategoryPress={jest.fn()} onAdd={jest.fn()} {...props} />
    </UndoProvider>,
  );
}

function expenseShare(): string | number | undefined {
  const style = StyleSheet.flatten(screen.getByTestId("expense-share").props.style);
  return style.width as string | number | undefined;
}

describe("Chalkboard", () => {
  beforeEach(() => load());

  it("shows the summary for all accounts", async () => {
    await renderBoard();

    expect(screen.getByText("All Accounts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next account" })).toBeTruthy();

    expect(screen.getByText("Income")).toBeTruthy();
    expect(screen.getByText("€95,603.20")).toBeTruthy();
    expect(screen.getByText("Carry Over")).toBeTruthy();
    expect(screen.getByText("+€95,603.20")).toBeTruthy();
    expect(screen.queryByText("Transfer in")).toBeNull();

    expect(screen.getByText("Expense")).toBeTruthy();
    expect(screen.getByText("€3,168.49")).toBeTruthy();
    const lines = screen.getAllByTestId("expense-category").map((line) => line.props.accessibilityLabel);
    expect(lines).toEqual([
      "Groceries, 1,552 euro 30",
      "Rent, 1,150 euro",
      "Shopping, 466 euro 19",
    ]);
    expect(screen.queryByText("Transfer out")).toBeNull();

    expect(screen.getByTestId("balance-divider")).toBeTruthy();
    expect(screen.getByText("Balance")).toBeTruthy();
    expect(screen.getByText("+€92,434.71")).toBeTruthy();

    expect(screen.getByRole("button", { name: "+ Expense" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Income" })).toBeTruthy();
  });

  it("reads the summary for screen readers", async () => {
    await renderBoard();
    expect(screen.getByTestId("chalkboard-summary").props.accessibilityLabel).toBe(
      "Income 95,603 euro 20, expense 3,168 euro 49, balance plus 92,434 euro 71",
    );
  });

  it("shows income categories below Carry Over", async () => {
    load({}, {
      transactions: [
        ...transactions,
        tx({ type: "income", amount_minor: 300000, date: "2026-10-15", account_id: "bank", category_id: "salary" }),
      ],
    });
    await renderBoard();
    expect(screen.getByText("€98,603.20")).toBeTruthy();
    const income = screen.getAllByTestId("income-category").map((line) => line.props.accessibilityLabel);
    expect(income).toEqual(["Salary, 3,000 euro"]);
  });

  it("colours the expense share of income in the bar", async () => {
    await renderBoard();
    expect(expenseShare()).toBe(`${(316849 / 9560320) * 100}%`);
  });

  it("colours the expense share of the budget in budget mode", async () => {
    load(
      { budget_mode: true },
      { budgets: [{ id: "b1", user_id: "u1", period: "monthly", amount_minor: 500000, category_id: null }] },
    );
    await renderBoard();
    expect(expenseShare()).toBe(`${(316849 / 500000) * 100}%`);
  });

  it("leaves out Carry Over when the setting is off", async () => {
    load({ carry_over: false });
    await renderBoard();
    expect(screen.queryByText("Carry Over")).toBeNull();
    expect(screen.getByText("€0.00")).toBeTruthy();
    expect(screen.getByText("-€3,168.49")).toBeTruthy();
  });

  it("cycles through All Accounts and each account", async () => {
    await renderBoard();
    const next = screen.getByRole("button", { name: "Next account" });

    await fireEvent.press(next);
    expect(screen.getByText("Bank")).toBeTruthy();

    await fireEvent.press(next);
    expect(screen.getByText("Wallet")).toBeTruthy();
    expect(screen.getByText("€500.00")).toBeTruthy();
    expect(screen.getByText("Transfer in")).toBeTruthy();
    expect(screen.getByText("€100.00")).toBeTruthy();
    expect(screen.getByText("Transfer out")).toBeTruthy();
    expect(screen.getByText("€0.00")).toBeTruthy();
    expect(screen.getByText("+€133.81")).toBeTruthy();

    await fireEvent.press(next);
    expect(screen.getByText("All Accounts")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Previous account" }));
    expect(screen.getByText("Wallet")).toBeTruthy();
  });

  it("opens Transactions for a category line", async () => {
    const onCategoryPress = jest.fn();
    await renderBoard({ onCategoryPress });
    await fireEvent.press(screen.getByText("Groceries"));
    expect(onCategoryPress).toHaveBeenCalledWith("groceries", null);

    await fireEvent.press(screen.getByRole("button", { name: "Next account" }));
    await fireEvent.press(screen.getByText("Rent"));
    expect(onCategoryPress).toHaveBeenLastCalledWith("rent", "bank");
  });

  it("starts a new expense or income", async () => {
    const onAdd = jest.fn();
    await renderBoard({ onAdd });
    await fireEvent.press(screen.getByRole("button", { name: "+ Expense" }));
    await fireEvent.press(screen.getByRole("button", { name: "+ Income" }));
    expect(onAdd.mock.calls).toEqual([["expense"], ["income"]]);
  });

  it("shows the rotate hint only on a phone", async () => {
    await renderBoard();
    expect(screen.queryByText("** Rotate device to view reports **")).toBeNull();

    await renderBoard({ showRotateHint: true });
    expect(screen.getByText("** Rotate device to view reports **")).toBeTruthy();
  });

  it("uses the summary font and a chalk text shadow", async () => {
    await renderBoard();
    const style = StyleSheet.flatten(screen.getByText("Balance").props.style);
    expect(style.fontFamily).toBe("DroidSansMono");
    expect(style.textShadowColor).toBeDefined();
  });
});
