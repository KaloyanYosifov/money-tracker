import { act, fireEvent, render, screen, within } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import { AppState, Pressable, StyleSheet } from "react-native";

import { UndoProvider, useUndo } from "../../data/UndoProvider";
import type { Shortcuts } from "../../hooks/useShortcuts";
import { Chalkboard, spokenAmount } from "./Chalkboard";
import { TransactionList } from "./TransactionList";

let mockDb: TestDatabase;

// The last handlers that the list passed to useShortcuts.
let mockShortcuts: Shortcuts = {};
jest.mock("../../hooks/useShortcuts", () => ({
  useShortcuts: (handlers: Shortcuts) => {
    mockShortcuts = handlers;
  },
}));

// False while a form covers the list.
let mockFocused = true;
jest.mock("expo-router", () => ({
  useIsFocused: () => mockFocused,
}));

// The hooks run their SQL against the in-memory fixture database.
// mockLoading simulates a query that has not finished: no rows yet.
let mockLoading = false;
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) =>
    mockLoading ? { data: [], isLoading: true } : { data: mockDb.prepare(sql).all(parameters), isLoading: false },
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
  { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "coins", color: "#000000", sort_order: 0 },
  { id: "rent", user_id: "u1", type: "expense", name: "Rent", icon: "key", color: "#000000", sort_order: 1 },
  { id: "groceries", user_id: "u1", type: "expense", name: "Groceries", icon: "cart", color: "#000000", sort_order: 2 },
];

function tx(id: string, fields: Record<string, unknown>) {
  return { id, user_id: "u1", currency_code: "EUR", source: "manual", ...fields };
}

const transactions = [
  // Before October: the carry over is 950.00 on Bank and 50.00 on Wallet.
  tx("sep-salary", { type: "income", amount_minor: 100000, date: "2026-09-01", name: "Salary", account_id: "bank", category_id: "salary" }),
  tx("sep-transfer", { type: "transfer", amount_minor: 5000, date: "2026-09-02", name: "Top up", account_id: "bank", to_account_id: "wallet" }),
  // October: income 3,000.00 and expenses of 1,164.99.
  tx("rent", { type: "expense", amount_minor: 115000, date: "2026-10-01", name: "Flat rent", account_id: "bank", category_id: "rent" }),
  tx("lunch", { type: "expense", amount_minor: 1499, date: "2026-10-05", name: "Lunch", note: "with Ana", account_id: "bank", category_id: "groceries" }),
  tx("top-up", { type: "transfer", amount_minor: 2000, date: "2026-10-07", name: "Top up", account_id: "bank", to_account_id: "wallet" }),
  tx("salary", { type: "income", amount_minor: 300000, date: "2026-10-15", name: "October salary", account_id: "bank", category_id: "salary" }),
];

function load(extra: Record<string, Record<string, unknown>[]> = {}) {
  mockDb = createTestDatabase();
  loadFixture(mockDb, { user_settings: [userSettings], accounts, categories, transactions, ...extra });
}

const execute = jest.fn().mockResolvedValue({ rowsAffected: 1 });

async function renderList(props: Partial<Parameters<typeof TransactionList>[0]> = {}) {
  return render(
    <UndoProvider db={{ execute }}>
      <TransactionList period={october} locale="en-GB" layout="phone" onOpen={jest.fn()} onShift={jest.fn()} {...props} />
    </UndoProvider>,
  );
}

/** The slide of a swiped row, in points. */
function translateX(row: ReturnType<typeof screen.getByTestId>): number {
  const style = StyleSheet.flatten(within(row).getByTestId("row-slide").props.style) as { transform?: { translateX: number }[] };
  return style?.transform?.[0]?.translateX ?? 0;
}

function rowNames(): string[] {
  return screen.getAllByTestId("transaction-row").map((row) => String(row.props.accessibilityLabel).split(",")[0]);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockLoading = false;
  mockFocused = true;
  mockShortcuts = {};
  execute.mockClear();
  load();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("TransactionList", () => {
  it("shows the paper bar, the totals and the list with Carry Over rows", async () => {
    await renderList();

    expect(screen.getByTestId("paper-bar-title").props.children).toBe("All Accounts");
    expect(screen.getByTestId("income-total").props.children).toBe("€4,000.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,164.99");
    expect(rowNames()).toEqual(["October salary", "Top up", "Lunch", "Flat rent", "Carry Over", "Carry Over"]);
  });

  it("shows the bottom toolbar on the phone", async () => {
    const onShift = jest.fn();
    await renderList({ onShift });

    await fireEvent.press(screen.getByRole("button", { name: "Previous period" }));
    await fireEvent.press(screen.getByRole("button", { name: "Next period" }));
    expect(onShift.mock.calls).toEqual([[-1], [1]]);
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose account" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search transactions ( / )")).toBeNull();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });

  it("shows search, Sort, Filter and a disabled Export on the web", async () => {
    await renderList({ layout: "web" });

    expect(screen.getByPlaceholderText("Search transactions ( / )")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose account" })).toBeTruthy();
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    expect(screen.queryByText("Coming soon")).toBeNull();
    await fireEvent(screen.getByTestId("export"), "pointerEnter");
    expect(screen.getByText("Coming soon")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous period" })).toBeNull();
  });

  it("picks one account", async () => {
    await renderList();

    await fireEvent.press(screen.getByRole("button", { name: "Choose account" }));
    await fireEvent.press(screen.getByRole("menuitem", { name: "Wallet" }));

    expect(screen.getByTestId("paper-bar-title").props.children).toBe("Wallet");
    expect(rowNames()).toEqual(["Top up", "Carry Over"]);
    expect(screen.getByTestId("income-total").props.children).toBe("€50.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€0.00");
  });

  it("filters by type", async () => {
    await renderList();

    await fireEvent.press(screen.getByRole("button", { name: "Filter" }));
    await fireEvent.press(screen.getByRole("menuitem", { name: "Expense" }));

    expect(rowNames()).toEqual(["Lunch", "Flat rent"]);
    expect(screen.getByTestId("income-total").props.children).toBe("€0.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,164.99");
  });

  it("shows the type filter in the title on the phone", async () => {
    await renderList();

    await fireEvent.press(screen.getByRole("button", { name: "Filter" }));
    await fireEvent.press(screen.getByRole("menuitem", { name: "Expense" }));
    expect(screen.getByTestId("paper-bar-title").props.children).toBe("All Accounts · Expense");
  });

  it("shows no empty message and no 0 totals while the queries load", async () => {
    mockLoading = true;
    await renderList();

    expect(screen.queryByText("No transactions in this period")).toBeNull();
    expect(screen.getByTestId("income-total").props.children).toBe(" ");
    expect(screen.getByTestId("expense-total").props.children).toBe(" ");
  });

  it("shows the empty message after the queries load", async () => {
    load({ transactions: [] });
    await renderList();
    expect(screen.getByText("No transactions in this period")).toBeTruthy();
  });

  it("shows the note of a transaction when Show Transaction Note is on", async () => {
    await renderList();
    expect(screen.getByText("with Ana")).toBeTruthy();
  });

  it("shows no note when Show Transaction Note is off", async () => {
    load({ user_settings: [{ ...userSettings, show_note: false }] });
    await renderList();
    expect(screen.queryByText("with Ana")).toBeNull();
  });

  it("leaves a pending delete out of the totals until Undo", async () => {
    await renderList({ layout: "web" });

    await fireEvent(screen.getByTestId("row-lunch"), "keyDown", { nativeEvent: { key: "Delete" } });
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,150.00");
    expect(screen.getByTestId("income-total").props.children).toBe("€4,000.00");
    await fireEvent.press(screen.getByRole("button", { name: "Deleted. Undo" }));
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,164.99");

    await fireEvent(screen.getByTestId("row-salary"), "keyDown", { nativeEvent: { key: "Delete" } });
    expect(screen.getByTestId("income-total").props.children).toBe("€1,000.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,164.99");
  });

  it("shows the Undo toast above the bottom toolbar on the phone", async () => {
    await renderList();
    await fireEvent(screen.getByTestId("toolbar"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 50 } } });
    const row = screen.getByTestId("row-lunch");
    await fireEvent(row, "touchStart", { nativeEvent: { pageX: 300, pageY: 100 } });
    await fireEvent(row, "responderRelease", { nativeEvent: { pageX: 160, pageY: 100 } });

    expect(StyleSheet.flatten(screen.getByTestId("undo-toast").props.style).bottom).toBe(74);
  });

  it("slides the row with the finger over a red Delete area, and back on a short swipe", async () => {
    await renderList();
    const row = screen.getByTestId("row-lunch");
    expect(within(row).getByText("Delete")).toBeTruthy();

    await fireEvent(row, "touchStart", { nativeEvent: { pageX: 300, pageY: 100 } });
    await fireEvent(row, "responderMove", { nativeEvent: { pageX: 260, pageY: 101 } });
    expect(translateX(row)).toBe(-40);
    expect(row.props.onResponderTerminationRequest()).toBe(false);

    await fireEvent(row, "responderRelease", { nativeEvent: { pageX: 270, pageY: 101 } });
    await act(async () => jest.runAllTimers());
    expect(screen.getByText("Lunch")).toBeTruthy();
    expect(translateX(screen.getByTestId("row-lunch"))).toBe(0);
  });

  it("shows the active filter on the Filter button on the web", async () => {
    await renderList({ layout: "web" });
    const filter = () => screen.getByRole("button", { name: "Filter" });
    expect(screen.getByText("Filter ▾")).toBeTruthy();
    expect(filter().props.accessibilityValue?.text).toBeUndefined();

    await fireEvent.press(filter());
    await fireEvent.press(screen.getByRole("menuitem", { name: "Expense" }));

    expect(screen.queryByText("Filter ▾")).toBeNull();
    expect(screen.getByText("Expense ▾")).toBeTruthy();
    expect(filter().props.accessibilityValue?.text).toBe("Expense");
  });

  it("shows the same totals as the Spending chalkboard for a negative Carry Over", async () => {
    // Before October: Bank 950.00 and Wallet 50.00 - 1,015.99, so the Carry Over is -15.99 in all.
    load({
      transactions: [
        ...transactions,
        tx("sep-rent", { type: "expense", amount_minor: 101599, date: "2026-09-10", name: "Deposit", account_id: "wallet", category_id: "rent" }),
      ],
    });
    await renderList();
    // The Carry Over stays on the income side, also when it is negative: 3,000.00 - 15.99.
    expect(screen.getByTestId("income-total").props.children).toBe("€2,984.01");
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,164.99");

    await render(
      <UndoProvider db={{ execute }}>
        <Chalkboard period={october} locale="en-GB" onCategoryPress={jest.fn()} onAdd={jest.fn()} />
      </UndoProvider>,
    );
    const summary = String(screen.getByTestId("chalkboard-summary").props.accessibilityLabel);
    expect(summary).toContain(`Income ${spokenAmount(298401, "EUR")}`);
    expect(summary).toContain(`expense ${spokenAmount(116499, "EUR")}`);
  });

  it("shows the same totals as the Spending chalkboard while a delete is pending", async () => {
    // iPad landscape shows both at once.
    await render(
      <UndoProvider db={{ execute }}>
        <Chalkboard period={october} locale="en-GB" onCategoryPress={jest.fn()} onAdd={jest.fn()} />
        <TransactionList period={october} locale="en-GB" layout="web" onOpen={jest.fn()} onShift={jest.fn()} />
      </UndoProvider>,
    );
    const summary = () => String(screen.getByTestId("chalkboard-summary").props.accessibilityLabel);

    await fireEvent(screen.getByTestId("row-lunch"), "keyDown", { nativeEvent: { key: "Delete" } });
    await fireEvent(screen.getByTestId("row-salary"), "keyDown", { nativeEvent: { key: "Delete" } });

    // Income 4,000.00 - 3,000.00 and expense 1,164.99 - 14.99.
    expect(screen.getByTestId("income-total").props.children).toBe("€1,000.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,150.00");
    expect(summary()).toContain(`Income ${spokenAmount(100000, "EUR")}`);
    expect(summary()).toContain(`expense ${spokenAmount(115000, "EUR")}`);
    expect(summary()).toContain(`balance ${spokenAmount(-15000, "EUR", true)}`);
    expect(screen.queryByText("Salary")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Deleted. Undo" }));
    expect(screen.getByTestId("income-total").props.children).toBe("€4,000.00");
    expect(summary()).toContain(`Income ${spokenAmount(400000, "EUR")}`);
  });

  it("starts with the category and account from Spending", async () => {
    await renderList({ initialCategoryId: "groceries", initialAccountId: "bank" });

    expect(screen.getByTestId("paper-bar-title").props.children).toBe("Bank · Groceries");
    expect(rowNames()).toEqual(["Lunch"]);
    expect(screen.getByTestId("income-total").props.children).toBe("€0.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€14.99");

    await fireEvent.press(screen.getByRole("button", { name: "Filter" }));
    await fireEvent.press(screen.getByRole("menuitem", { name: "All categories" }));
    expect(screen.getByTestId("paper-bar-title").props.children).toBe("Bank");
    expect(screen.getByTestId("income-total").props.children).toBe("€3,950.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€1,164.99");
  });

  it("sorts on the web", async () => {
    await renderList({ layout: "web" });

    await fireEvent.press(screen.getByRole("button", { name: "Sort" }));
    await fireEvent.press(screen.getByRole("menuitem", { name: "Amount" }));

    expect(rowNames()).toEqual(["Carry Over", "Carry Over", "October salary", "Flat rent", "Top up", "Lunch"]);
  });

  it("filters while typing after 200 ms", async () => {
    await renderList({ layout: "web" });

    await fireEvent.changeText(screen.getByPlaceholderText("Search transactions ( / )"), "ana");
    await act(async () => jest.advanceTimersByTime(199));
    expect(rowNames()).toHaveLength(6);

    await act(async () => jest.advanceTimersByTime(1));
    expect(rowNames()).toEqual(["Lunch"]);
    expect(screen.getByTestId("income-total").props.children).toBe("€0.00");
    expect(screen.getByTestId("expense-total").props.children).toBe("€14.99");
  });

  it("focuses search with / on the web, but not while a form covers the list", async () => {
    const view = await renderList({ layout: "web" });
    expect(mockShortcuts.focusSearch).toBeDefined();

    mockFocused = false;
    await view.rerender(
      <UndoProvider db={{ execute }}>
        <TransactionList period={october} locale="en-GB" layout="web" onOpen={jest.fn()} onShift={jest.fn()} />
      </UndoProvider>,
    );
    expect(mockShortcuts.focusSearch).toBeUndefined();
  });

  it("opens the form on a tap", async () => {
    const onOpen = jest.fn();
    await renderList({ onOpen });

    await fireEvent.press(screen.getByText("Lunch"));
    expect(onOpen).toHaveBeenCalledWith("lunch");

    await fireEvent.press(screen.getAllByText("Carry Over")[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("starts the delete on a swipe left and hides the row", async () => {
    await renderList();
    const row = screen.getByTestId("row-lunch");

    await fireEvent(row, "touchStart", { nativeEvent: { pageX: 300, pageY: 100 } });
    expect(row.props.onMoveShouldSetResponder({ nativeEvent: { pageX: 280, pageY: 101 } })).toBe(true);
    await fireEvent(row, "responderRelease", { nativeEvent: { pageX: 160, pageY: 102 } });

    expect(screen.queryByText("Lunch")).toBeNull();
    expect(screen.getByText("Deleted · Undo")).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(5000));
    expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["lunch"]);
    expect(screen.queryByText("Deleted · Undo")).toBeNull();
  });

  it("shows Undo after a delete from the transaction form", async () => {
    // The form deletes with requestDelete and closes. The list below it offers the Undo.
    function FormDelete() {
      const { requestDelete } = useUndo();
      return <Pressable accessibilityRole="button" accessibilityLabel="Form delete" onPress={() => requestDelete("lunch")} />;
    }
    await render(
      <UndoProvider db={{ execute }}>
        <TransactionList period={october} locale="en-GB" layout="phone" onOpen={jest.fn()} onShift={jest.fn()} />
        <FormDelete />
      </UndoProvider>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Form delete" }));
    expect(screen.queryByText("Lunch")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Deleted. Undo" }));
    expect(screen.getByText("Lunch")).toBeTruthy();
    expect(screen.queryByText("Deleted · Undo")).toBeNull();
  });

  it("hides the Undo toast when the app goes to the background and the delete runs early", async () => {
    // The provider subscribes once, on mount.
    let appStateListener: ((state: string) => void) | undefined;
    jest.spyOn(AppState, "addEventListener").mockImplementationOnce((_type, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    await renderList({ layout: "web" });
    await fireEvent(screen.getByTestId("row-lunch"), "keyDown", { nativeEvent: { key: "Delete" } });
    expect(screen.getByText("Deleted · Undo")).toBeTruthy();

    await act(async () => appStateListener?.("background"));

    expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["lunch"]);
    expect(screen.queryByText("Deleted · Undo")).toBeNull();
    expect(screen.queryByText("Lunch")).toBeNull();
  });

  it("ignores a short or vertical swipe", async () => {
    await renderList();
    const row = screen.getByTestId("row-lunch");

    await fireEvent(row, "touchStart", { nativeEvent: { pageX: 300, pageY: 100 } });
    expect(row.props.onMoveShouldSetResponder({ nativeEvent: { pageX: 298, pageY: 160 } })).toBe(false);
    await fireEvent(row, "responderRelease", { nativeEvent: { pageX: 280, pageY: 100 } });

    expect(screen.getByText("Lunch")).toBeTruthy();
  });

  it("starts the delete with the Delete key on the web", async () => {
    await renderList({ layout: "web" });

    await fireEvent(screen.getByTestId("row-rent"), "keyDown", { nativeEvent: { key: "Delete" } });
    expect(screen.queryByText("Flat rent")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Deleted. Undo" }));
    expect(screen.getByText("Flat rent")).toBeTruthy();
  });

  it("does not delete Carry Over rows", async () => {
    await renderList({ layout: "web" });

    await fireEvent(screen.getByTestId("row-carryOver:bank"), "keyDown", { nativeEvent: { key: "Delete" } });
    expect(screen.getAllByText("Carry Over")).toHaveLength(2);
  });

  it("renders 50,000 rows with a virtualised list", async () => {
    const many = Array.from({ length: 50_000 }, (_, i) =>
      tx(`bulk-${i}`, {
        type: "expense",
        amount_minor: 100 + i,
        date: `2026-10-${String((i % 31) + 1).padStart(2, "0")}`,
        name: `Bulk ${i}`,
        account_id: "bank",
        category_id: "groceries",
      }),
    );
    load({ transactions: many });

    await renderList();

    const rendered = screen.getAllByTestId("transaction-row").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    expect(screen.getByTestId("transaction-list").props.data).toHaveLength(50_000);
  });
});
