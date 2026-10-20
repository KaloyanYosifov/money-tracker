import { act, fireEvent, render, screen, within } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import { UndoProvider } from "../../data/UndoProvider";
import { occurrenceId } from "../../domain/ids";
import { TransactionForm } from "./TransactionForm";

let mockDb: TestDatabase;

// The hooks run their SQL against the in-memory fixture database, and the
// mutations write to it.
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) => ({
    data: mockDb.prepare(sql).all(parameters),
    isLoading: false,
  }),
  usePowerSync: () => jest.requireActual("../../../test/sqlite").asyncDatabase(mockDb),
}));

const TODAY = "2026-10-19";

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
  { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "coins", color: "#000000", sort_order: 0 },
  { id: "rent", user_id: "u1", type: "expense", name: "Rent", icon: "key", color: "#000000", sort_order: 1 },
  { id: "groceries", user_id: "u1", type: "expense", name: "Groceries", icon: "cart", color: "#000000", sort_order: 2 },
  {
    id: "old",
    user_id: "u1",
    type: "expense",
    name: "Old",
    icon: "cart",
    color: "#000000",
    sort_order: 3,
    archived_at: "2026-01-01T00:00:00Z",
  },
];

const lunch = {
  id: "lunch",
  user_id: "u1",
  currency_code: "EUR",
  source: "manual",
  type: "expense",
  amount_minor: 1499,
  date: "2026-10-05",
  name: "Lunch",
  note: "with Ana",
  account_id: "bank",
  category_id: "groceries",
};

function load(extra: Record<string, Record<string, unknown>[]> = {}) {
  mockDb = createTestDatabase();
  loadFixture(mockDb, {
    user_settings: [userSettings],
    accounts,
    categories,
    transactions: [lunch],
    device_prefs: [{ id: "lastAccountId", key: "lastAccountId", value: "wallet" }],
    ...extra,
  });
}

const execute = jest.fn().mockResolvedValue({ rowsAffected: 1 });

async function renderForm(props: Partial<Parameters<typeof TransactionForm>[0]> = {}) {
  const onClose = jest.fn();
  await render(
    <UndoProvider db={{ execute }}>
      <TransactionForm id={null} platform="ios" locale="en-GB" today={TODAY} onClose={onClose} {...props} />
    </UndoProvider>,
  );
  return onClose;
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" });
}

function isDisabled(element: ReturnType<typeof saveButton>) {
  return Boolean(element.props.accessibilityState?.disabled);
}

async function typeAmount(...keys: string[]) {
  await fireEvent.press(screen.getByRole("button", { name: /^Amount/ }));
  for (const key of keys) {
    await fireEvent.press(screen.getByRole("button", { name: key }));
  }
}

async function saveAndWait() {
  await act(async () => {
    fireEvent.press(saveButton());
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  execute.mockClear();
  load();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("TransactionForm", () => {
  it("opens an empty expense form with today, the last used account and the active expense categories", async () => {
    await renderForm();

    expect(screen.getByText("New Expense")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Expense" }).props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByDisplayValue(TODAY)).toBeTruthy();
    expect(screen.getByPlaceholderText("Name").props.value).toBe("");

    const grid = within(screen.getByLabelText("Category"));
    expect(grid.getAllByRole("radio").map((r) => r.props.accessibilityLabel)).toEqual(["Rent", "Groceries"]);

    const account = within(screen.getByLabelText("Account"));
    expect(account.getByRole("radio", { name: "Wallet" }).props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true }),
    );
    expect(isDisabled(saveButton())).toBe(true);
  });

  it("opens with the type from the route", async () => {
    await renderForm({ initialType: "income" });

    expect(screen.getByText("New Income")).toBeTruthy();
    const grid = within(screen.getByLabelText("Category"));
    expect(grid.getAllByRole("radio").map((r) => r.props.accessibilityLabel)).toEqual(["Salary"]);
  });

  it("shows From and To and no category for a transfer", async () => {
    await renderForm();

    await fireEvent.press(screen.getByRole("tab", { name: "Transfer" }));

    expect(screen.queryByLabelText("Category")).toBeNull();
    expect(screen.queryByLabelText("Account")).toBeNull();
    expect(screen.getByLabelText("From")).toBeTruthy();
    expect(screen.getByLabelText("To")).toBeTruthy();
  });

  it("opens the keypad from the amount field", async () => {
    await renderForm();
    expect(screen.queryByRole("button", { name: "plus" })).toBeNull();

    await typeAmount("1", "4", "decimal point", "9", "9");

    expect(screen.getByRole("button", { name: "Amount, €14.99" })).toBeTruthy();
  });

  it("saves a new expense and remembers the account", async () => {
    const onClose = await renderForm();

    await typeAmount("1", "2");
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Bread");
    await fireEvent.press(within(screen.getByLabelText("Category")).getByRole("radio", { name: "Groceries" }));
    await fireEvent.press(within(screen.getByLabelText("Account")).getByRole("radio", { name: "Bank" }));
    await fireEvent.changeText(screen.getByPlaceholderText("Add a note"), "fresh");
    expect(isDisabled(saveButton())).toBe(false);

    await saveAndWait();

    const saved = mockDb.prepare("SELECT * FROM transactions WHERE name = 'Bread'").get();
    expect(saved).toEqual(
      expect.objectContaining({
        type: "expense",
        amount_minor: 1200,
        date: TODAY,
        category_id: "groceries",
        account_id: "bank",
        to_account_id: null,
        note: "fresh",
        source: "manual",
      }),
    );
    expect(mockDb.prepare("SELECT value FROM device_prefs WHERE id = 'lastAccountId'").get()).toEqual({ value: "bank" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows validation errors under the fields and keeps Save disabled", async () => {
    await renderForm();

    await fireEvent.press(screen.getByRole("tab", { name: "Transfer" }));
    await typeAmount("5");
    await fireEvent.press(within(screen.getByLabelText("To")).getByRole("radio", { name: "Wallet" }));
    expect(screen.getByTestId("error-to_account_id").props.children).toBe("Pick a different account");

    await fireEvent.changeText(screen.getByDisplayValue(TODAY), "2026-02-30");
    expect(screen.getByTestId("error-date").props.children).toBe("Use a date like 2026-10-19");
    expect(isDisabled(saveButton())).toBe(true);

    await fireEvent.press(within(screen.getByLabelText("To")).getByRole("radio", { name: "Bank" }));
    await fireEvent.changeText(screen.getByDisplayValue("2026-02-30"), "2026-10-18");
    expect(screen.queryByTestId("error-to_account_id")).toBeNull();
    expect(isDisabled(saveButton())).toBe(false);
  });

  it("does not show errors for fields the user has not changed", async () => {
    await renderForm();

    expect(screen.queryByTestId("error-amount_minor")).toBeNull();
    expect(screen.queryByTestId("error-category_id")).toBeNull();
  });

  it("opens an existing transaction and saves the changes", async () => {
    const onClose = await renderForm({ id: "lunch" });

    expect(screen.getByText("Edit Transaction")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Amount, €14.99" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Name").props.value).toBe("Lunch");
    expect(screen.getByDisplayValue("2026-10-05")).toBeTruthy();
    expect(within(screen.getByLabelText("Account")).getByRole("radio", { name: "Bank" }).props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true }),
    );

    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Team lunch");
    await saveAndWait();

    expect(mockDb.prepare("SELECT name, amount_minor, note FROM transactions WHERE id = 'lunch'").get()).toEqual({
      name: "Team lunch",
      amount_minor: 1499,
      note: "with Ana",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a rule for a repeating transaction and runs the generator", async () => {
    await renderForm();

    await typeAmount("5", "0");
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Gym");
    await fireEvent.press(within(screen.getByLabelText("Category")).getByRole("radio", { name: "Rent" }));
    await fireEvent.changeText(screen.getByDisplayValue(TODAY), "2026-09-19");
    expect(screen.queryByLabelText("Every")).toBeNull();
    await fireEvent(screen.getByRole("switch", { name: "Repeating" }), "valueChange", true);
    await fireEvent.press(within(screen.getByLabelText("Every")).getByRole("radio", { name: "Monthly" }));
    await fireEvent.changeText(screen.getByPlaceholderText("Never"), "2027-09-19");
    await saveAndWait();

    const rule = mockDb.prepare("SELECT * FROM recurring_rules").get() as { id: string };
    expect(rule).toEqual(
      expect.objectContaining({
        type: "expense",
        amount_minor: 5000,
        name: "Gym",
        category_id: "rent",
        account_id: "wallet",
        frequency: "monthly",
        start_date: "2026-09-19",
        end_date: "2027-09-19",
      }),
    );
    expect(
      mockDb.prepare("SELECT date, recurring_rule_id FROM transactions WHERE name = 'Gym' ORDER BY date").all(),
    ).toEqual([
      { date: "2026-09-19", recurring_rule_id: rule.id },
      { date: "2026-10-19", recurring_rule_id: rule.id },
    ]);
  });

  it("updates the rule of a repeating transaction", async () => {
    const gymOct = occurrenceId("gym-rule", "2026-10-01");
    load({
      recurring_rules: [
        {
          id: "gym-rule",
          user_id: "u1",
          type: "expense",
          amount_minor: 5000,
          name: "Gym",
          category_id: "rent",
          account_id: "bank",
          frequency: "monthly",
          start_date: "2026-10-01",
        },
      ],
      transactions: [
        { ...lunch, id: gymOct, amount_minor: 5000, name: "Gym", date: "2026-10-01", category_id: "rent", recurring_rule_id: "gym-rule", source: "recurring" },
      ],
    });
    await renderForm({ id: gymOct });

    expect(screen.getByRole("switch", { name: "Repeating" }).props.value).toBe(true);
    expect(within(screen.getByLabelText("Every")).getByRole("radio", { name: "Monthly" }).props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true }),
    );

    await fireEvent.press(within(screen.getByLabelText("Every")).getByRole("radio", { name: "Weekly" }));
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Gym club");
    await saveAndWait();

    expect(mockDb.prepare("SELECT name, frequency, start_date FROM recurring_rules WHERE id = 'gym-rule'").get()).toEqual({
      name: "Gym club",
      frequency: "weekly",
      start_date: "2026-10-01",
    });
    expect(mockDb.prepare("SELECT name FROM transactions WHERE id = ?").get(gymOct)).toEqual({ name: "Gym club" });
    expect(mockDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE recurring_rule_id = 'gym-rule'").get()).toEqual({
      n: 3,
    });
  });

  it("deletes with requestDelete and goes back, only in edit", async () => {
    const onClose = await renderForm({ id: "lunch" });

    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(onClose).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTime(5000));
    expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["lunch"]);
  });

  it("has no Delete for a new transaction", async () => {
    await renderForm();

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows Cancel and Save on iOS", async () => {
    const onClose = await renderForm();

    expect(screen.getByText("Save")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows ✕ and SAVE on the web", async () => {
    const onClose = await renderForm({ platform: "web" });

    expect(screen.getByText("SAVE")).toBeTruthy();
    expect(screen.getByText("✕")).toBeTruthy();
    expect(screen.queryByText("Cancel")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
