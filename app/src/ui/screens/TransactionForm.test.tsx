import { act, fireEvent, render, screen, within } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import { UndoProvider } from "../../data/UndoProvider";
import { occurrenceId } from "../../domain/ids";
import type { Shortcuts } from "../../hooks/useShortcuts";
import { TransactionForm } from "./TransactionForm";

let mockDb: TestDatabase;

// The last handlers that the form passed to useShortcuts.
let mockShortcuts: Shortcuts = {};
jest.mock("../../hooks/useShortcuts", () => ({
  useShortcuts: (handlers: Shortcuts) => {
    mockShortcuts = handlers;
  },
}));
// Simulates @powersync/react after a parameter change: the old rows stay, with isFetching, until the new query runs.
let mockStaleRules = false;

// The hooks run their SQL against the in-memory fixture database, and the
// mutations write to it.
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) =>
    mockStaleRules && sql.includes("FROM recurring_rules")
      ? { data: [], isLoading: false, isFetching: true }
      : { data: mockDb.prepare(sql).all(parameters), isLoading: false },
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

async function typeAmount(text: string) {
  await fireEvent.changeText(screen.getByLabelText("Amount"), text);
}

const SELECT_FIELDS = {
  Category: "transaction-category",
  Account: "transaction-account",
  From: "transaction-account",
  To: "transaction-to-account",
};

/** Opens a select field and picks the option. */
async function select(label: keyof typeof SELECT_FIELDS, name: string) {
  await fireEvent.press(screen.getByTestId(SELECT_FIELDS[label]));
  await fireEvent.press(within(screen.getByLabelText(label)).getByRole("radio", { name }));
}

async function saveAndWait() {
  await act(async () => {
    fireEvent.press(saveButton());
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockStaleRules = false;
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
    expect(screen.getByTestId("transaction-date").props.accessibilityLabel).toBe("Date, Today");
    expect(screen.getByPlaceholderText("Name").props.value).toBe("");

    expect(screen.getByTestId("transaction-category").props.accessibilityLabel).toBe("Category, Select a category");
    await fireEvent.press(screen.getByTestId("transaction-category"));
    const sheet = within(screen.getByLabelText("Category"));
    expect(sheet.getAllByRole("radio").map((r) => r.props.accessibilityLabel)).toEqual(["Rent", "Groceries"]);

    expect(screen.getByTestId("transaction-account").props.accessibilityLabel).toBe("Account, Wallet");
    // Save stays pressable. A press on it shows the errors.
    expect(isDisabled(saveButton())).toBe(false);
  });

  it("opens with the type from the route", async () => {
    await renderForm({ initialType: "income" });

    expect(screen.getByText("New Income")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("transaction-category"));
    const sheet = within(screen.getByLabelText("Category"));
    expect(sheet.getAllByRole("radio").map((r) => r.props.accessibilityLabel)).toEqual(["Salary"]);
  });

  it("shows the selected category in the field and closes the sheet", async () => {
    await renderForm();

    await select("Category", "Groceries");

    expect(screen.getByTestId("transaction-category").props.accessibilityLabel).toBe("Category, Groceries");
    expect(screen.queryByRole("radio", { name: "Rent" })).toBeNull();
  });

  it("shows From and To and no category for a transfer", async () => {
    await renderForm();

    await fireEvent.press(screen.getByRole("tab", { name: "Transfer" }));

    expect(screen.queryByTestId("transaction-category")).toBeNull();
    expect(screen.queryByText("Account")).toBeNull();
    expect(screen.getByTestId("transaction-account").props.accessibilityLabel).toBe("From, Wallet");
    expect(screen.getByTestId("transaction-to-account").props.accessibilityLabel).toBe("To, Select an account");
  });

  it("takes the amount from a decimal field, with either separator", async () => {
    const onClose = await renderForm();
    const field = screen.getByLabelText("Amount");
    expect(field.props.keyboardType).toBe("decimal-pad");

    await typeAmount("14,99");
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Coffee");
    await select("Category", "Groceries");
    await saveAndWait();

    expect(onClose).toHaveBeenCalled();
    expect(mockDb.prepare("SELECT amount_minor FROM transactions WHERE name = 'Coffee'").get()).toEqual({ amount_minor: 1499 });
  });

  it("saves a new expense and remembers the account", async () => {
    const onClose = await renderForm();

    await typeAmount("12");
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Bread");
    await select("Category", "Groceries");
    await select("Account", "Bank");
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

  it("shows validation errors under the fields and does not save", async () => {
    await renderForm();

    await fireEvent.press(screen.getByRole("tab", { name: "Transfer" }));
    await typeAmount("5");
    await select("To", "Wallet");
    expect(screen.getByTestId("error-to_account_id").props.children).toBe("Pick a different account");

    await saveAndWait();
    expect(mockDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'transfer'").get()).toEqual({ n: 0 });

    await select("To", "Bank");
    expect(screen.queryByTestId("error-to_account_id")).toBeNull();
    expect(isDisabled(saveButton())).toBe(false);
  });

  it("does not show errors for fields the user has not changed", async () => {
    await renderForm();

    expect(screen.queryByTestId("error-amount_minor")).toBeNull();
    expect(screen.queryByTestId("error-category_id")).toBeNull();
  });

  it("shows every error on a Save press and does not save", async () => {
    const onClose = await renderForm();
    const count = mockDb.prepare("SELECT COUNT(*) AS n FROM transactions").get();

    await typeAmount("12");
    expect(screen.queryByTestId("error-category_id")).toBeNull();

    await saveAndWait();
    expect(screen.getByTestId("error-category_id")).toBeTruthy();
    expect(mockDb.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual(count);
    expect(onClose).not.toHaveBeenCalled();

    await select("Category", "Groceries");
    expect(screen.queryByTestId("error-category_id")).toBeNull();
  });

  it("opens an existing transaction and saves the changes", async () => {
    const onClose = await renderForm({ id: "lunch" });

    expect(screen.getByText("Edit Transaction")).toBeTruthy();
    expect(screen.getByLabelText("Amount").props.value).toBe("14.99");
    expect(screen.getByPlaceholderText("Name").props.value).toBe("Lunch");
    expect(screen.getByTestId("transaction-date").props.accessibilityLabel).toBe("Date, Mon, 5 Oct 2026");
    expect(screen.getByTestId("transaction-account").props.accessibilityLabel).toBe("Account, Bank");

    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Team lunch");
    await saveAndWait();

    expect(mockDb.prepare("SELECT name, amount_minor, note FROM transactions WHERE id = 'lunch'").get()).toEqual({
      name: "Team lunch",
      amount_minor: 1499,
      note: "with Ana",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Quarterly between Monthly and Yearly", async () => {
    await renderForm();

    await fireEvent(screen.getByRole("switch", { name: "Repeating" }), "valueChange", true);

    const labels = within(screen.getByLabelText("Every"))
      .getAllByRole("radio")
      .map((radio) => radio.props.accessibilityLabel);
    expect(labels).toEqual(["Daily", "Weekly", "Every 2 weeks", "Monthly", "Quarterly", "Yearly"]);
  });

  it("creates a rule for a repeating transaction and runs the generator", async () => {
    await renderForm();

    await typeAmount("50");
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Gym");
    await select("Category", "Rent");
    await fireEvent.press(screen.getByTestId("transaction-date"));
    await fireEvent.press(screen.getByRole("button", { name: "Previous month" }));
    await fireEvent.press(screen.getByTestId("day-2026-09-19"));
    expect(screen.getByTestId("transaction-date").props.accessibilityLabel).toBe("Date, Sat, 19 Sept 2026");
    expect(screen.queryByLabelText("Every")).toBeNull();
    await fireEvent(screen.getByRole("switch", { name: "Repeating" }), "valueChange", true);
    await fireEvent.press(within(screen.getByLabelText("Every")).getByRole("radio", { name: "Monthly" }));
    expect(screen.getByTestId("transaction-end-date").props.accessibilityLabel).toBe("End Date, Never");
    await fireEvent.press(screen.getByTestId("transaction-end-date"));
    await fireEvent.press(screen.getByRole("button", { name: "Next month" }));
    await fireEvent.press(screen.getByRole("button", { name: "Next month" }));
    await fireEvent.press(screen.getByTestId("day-2026-12-19"));
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
        end_date: "2026-12-19",
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

  it("waits for the rule of a repeating transaction before it shows the form", async () => {
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
          frequency: "weekly",
          start_date: "2026-10-01",
        },
      ],
      transactions: [
        { ...lunch, id: gymOct, amount_minor: 5000, name: "Gym", date: "2026-10-01", category_id: "rent", recurring_rule_id: "gym-rule", source: "recurring" },
      ],
    });
    mockStaleRules = true;
    const onClose = jest.fn();
    const ui = () => (
      <UndoProvider db={{ execute }}>
        <TransactionForm id={gymOct} platform="ios" locale="en-GB" today={TODAY} onClose={onClose} />
      </UndoProvider>
    );
    await render(ui());
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    mockStaleRules = false;
    await screen.rerender(ui());
    expect(screen.getByRole("switch", { name: "Repeating" }).props.value).toBe(true);

    await fireEvent.changeText(screen.getByPlaceholderText("Add a note"), "paid");
    await saveAndWait();
    expect(mockDb.prepare("SELECT frequency, end_date FROM recurring_rules WHERE id = 'gym-rule'").get()).toEqual({
      frequency: "weekly",
      end_date: null,
    });
  });

  it("saves once when Save is pressed twice quickly", async () => {
    await renderForm();
    await typeAmount("12");
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Bread");
    await select("Category", "Groceries");

    await act(async () => {
      const button = saveButton();
      fireEvent.press(button);
      fireEvent.press(button);
    });

    expect(mockDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE name = 'Bread'").get()).toEqual({ n: 1 });
  });

  it("says the amount is not valid for text it cannot read", async () => {
    await renderForm();

    await typeAmount("12.345");
    expect(screen.getByTestId("error-amount_minor").props.children).toBe("Enter a valid amount");
    await typeAmount("0");
    expect(screen.getByTestId("error-amount_minor").props.children).toBe("Enter an amount above 0");
  });

  it("closes when the transaction does not exist, for example after a delete on another device", async () => {
    const onClose = await renderForm({ id: "gone" });

    expect(onClose).toHaveBeenCalledTimes(1);
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

  it("saves an edited name and closes on one press of Save", async () => {
    const onClose = await renderForm({ id: "lunch" });
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Lunch!");
    await saveAndWait();

    expect(mockDb.prepare("SELECT name FROM transactions WHERE id = 'lunch'").get()).toEqual({ name: "Lunch!" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("picks the date in the calendar and pauses Enter and Escape while it is open", async () => {
    await renderForm({ id: "lunch" });
    expect(mockShortcuts.save).toBeDefined();

    await fireEvent.press(screen.getByTestId("transaction-date"));
    expect(mockShortcuts).toEqual({});
    await fireEvent.press(screen.getByTestId("day-2026-10-07"));

    expect(mockShortcuts.save).toBeDefined();
    expect(screen.getByTestId("transaction-date").props.accessibilityLabel).toBe("Date, Wed, 7 Oct 2026");
    await saveAndWait();
    expect(mockDb.prepare("SELECT date FROM transactions WHERE id = 'lunch'").get()).toEqual({ date: "2026-10-07" });
  });

  it("uses the dark keyboard in the dark theme", async () => {
    load({ user_settings: [{ ...userSettings, theme: "dark" }] });
    await renderForm();
    expect(screen.getByPlaceholderText("Name").props.keyboardAppearance).toBe("dark");
    expect(screen.getByLabelText("Amount").props.keyboardAppearance).toBe("dark");
  });

  it("has a Done bar above the number pad of the amount", async () => {
    await renderForm();
    // The native Done bar of TextInput. An InputAccessoryView stops the field from taking focus after the form opens again.
    expect(screen.getByLabelText("Amount").props.inputAccessoryViewButtonLabel).toBe("Done");
    expect(screen.getByLabelText("Amount").props.inputAccessoryViewID).toBeUndefined();
  });
});
