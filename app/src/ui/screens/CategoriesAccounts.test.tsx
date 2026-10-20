import { fireEvent, render, screen, within } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import { AccountForm, AccountsScreen } from "./Accounts";
import { CategoriesScreen, CategoryForm } from "./Categories";

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

const categories = [
  { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "piggy", color: "#3b9d3b", sort_order: 0 },
  { id: "groceries", user_id: "u1", type: "expense", name: "Groceries", icon: "groceries", color: "#5aa454", sort_order: 2 },
  { id: "rent", user_id: "u1", type: "expense", name: "Rent", icon: "key", color: "#a0522d", sort_order: 1 },
  { id: "travel", user_id: "u1", type: "expense", name: "Travel", icon: "bus", color: "#2f8fd8", sort_order: 3 },
  {
    id: "old",
    user_id: "u1",
    type: "expense",
    name: "Old",
    icon: "cart",
    color: "#d6457a",
    sort_order: 4,
    archived_at: "2026-01-01T00:00:00Z",
  },
];

const accounts = [
  { id: "wallet", user_id: "u1", name: "Wallet", color: "#8a5a44", sort_order: 1 },
  { id: "bank", user_id: "u1", name: "Bank", color: "#1d4f9a", sort_order: 0 },
  { id: "spare", user_id: "u1", name: "Spare", color: "#5aa454", sort_order: 2 },
  { id: "closed", user_id: "u1", name: "Closed", color: "#8a8a8a", sort_order: 3, archived_at: "2026-01-01T00:00:00Z" },
];

const transactions = [
  {
    id: "lunch",
    user_id: "u1",
    currency_code: "EUR",
    source: "manual",
    type: "expense",
    amount_minor: 1499,
    date: "2026-10-05",
    name: "Lunch",
    account_id: "bank",
    category_id: "groceries",
  },
];

beforeEach(() => {
  mockDb = createTestDatabase();
  loadFixture(mockDb, { user_settings: [userSettings], categories, accounts, transactions });
});

function row(table: string, id: string) {
  return mockDb.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

function sortOrders(table: string, ids: string[]) {
  return ids.map((id) => row(table, id)?.sort_order);
}

function listTitles() {
  return within(screen.getByTestId("active-list"))
    .getAllByRole("button")
    .map((b) => b.props.accessibilityLabel)
    .filter((label) => !String(label).startsWith("Drag"));
}

describe("CategoriesScreen", () => {
  it("shows the Expense and Income switch and the categories of the type in sort_order with icons", async () => {
    await render(<CategoriesScreen platform="ios" onOpen={jest.fn()} onNew={jest.fn()} />);

    expect(screen.getByRole("tab", { name: "Expense" }).props.accessibilityState).toEqual({ selected: true });
    expect(listTitles()).toEqual(["Rent", "Groceries", "Travel"]);
    expect(screen.getByTestId("category-icon-key-filled")).toBeTruthy();
    expect(screen.getByTestId("category-icon-groceries-filled")).toBeTruthy();

    await fireEvent.press(screen.getByRole("tab", { name: "Income" }));
    expect(listTitles()).toEqual(["Salary"]);
  });

  it("opens the form for a new category of the shown type and for a tapped category", async () => {
    const onOpen = jest.fn();
    const onNew = jest.fn();
    await render(<CategoriesScreen platform="ios" onOpen={onOpen} onNew={onNew} />);

    await fireEvent.press(screen.getByRole("tab", { name: "Income" }));
    await fireEvent.press(screen.getByRole("button", { name: "New category" }));
    expect(onNew).toHaveBeenCalledWith("income");

    await fireEvent.press(screen.getByRole("button", { name: "Salary" }));
    expect(onOpen).toHaveBeenCalledWith("salary");
  });

  it("reorders with a long-press and a drag, then saves sort_order", async () => {
    await render(<CategoriesScreen platform="ios" onOpen={jest.fn()} onNew={jest.fn()} />);

    await fireEvent(screen.getByRole("button", { name: "Rent" }), "longPress");
    const item = screen.getByTestId("reorder-rent");
    expect(item.props.onMoveShouldSetResponderCapture()).toBe(true);
    await fireEvent(item, "responderGrant", { nativeEvent: { pageY: 100 } });
    await fireEvent(item, "responderRelease", { nativeEvent: { pageY: 205 } });

    expect(sortOrders("categories", ["groceries", "travel", "rent"])).toEqual([0, 1, 2]);
    expect(item.props.onMoveShouldSetResponderCapture()).toBe(false);
  });

  it("does not start a drag without a long-press on iOS", async () => {
    await render(<CategoriesScreen platform="ios" onOpen={jest.fn()} onNew={jest.fn()} />);

    expect(screen.getByTestId("reorder-rent").props.onMoveShouldSetResponderCapture()).toBe(false);
    expect(screen.queryByRole("button", { name: "Drag Rent" })).toBeNull();
  });

  it("reorders with the drag handle on the web", async () => {
    await render(<CategoriesScreen platform="web" onOpen={jest.fn()} onNew={jest.fn()} />);

    const handle = screen.getByRole("button", { name: "Drag Travel" });
    expect(handle.props.onStartShouldSetResponder()).toBe(true);
    await fireEvent(handle, "responderGrant", { nativeEvent: { pageY: 200 } });
    await fireEvent(handle, "responderRelease", { nativeEvent: { pageY: 100 } });

    expect(sortOrders("categories", ["travel", "rent", "groceries"])).toEqual([0, 1, 2]);
  });

  it("shows archived categories in a collapsed section with Restore", async () => {
    await render(<CategoriesScreen platform="ios" onOpen={jest.fn()} onNew={jest.fn()} />);

    const toggle = screen.getByRole("button", { name: "Archived (1)" });
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByRole("button", { name: "Restore Old" })).toBeNull();

    await fireEvent.press(toggle);
    await fireEvent.press(screen.getByRole("button", { name: "Restore Old" }));

    expect(row("categories", "old")?.archived_at).toBeNull();
  });
});

describe("CategoryForm", () => {
  it("creates a category with a name, an icon, a colour and a type", async () => {
    const onClose = jest.fn();
    await render(<CategoryForm id={null} initialType="expense" platform="ios" onClose={onClose} />);

    expect(screen.getByText("New Category")).toBeTruthy();
    expect(within(screen.getByLabelText("Colour")).getAllByRole("radio")).toHaveLength(12);
    expect(within(screen.getByLabelText("Icon")).getAllByRole("radio").length).toBeGreaterThan(20);
    expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toEqual({ disabled: true });
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    await fireEvent.press(screen.getByRole("tab", { name: "Income" }));
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Bonus");
    await fireEvent.press(within(screen.getByLabelText("Icon")).getByRole("radio", { name: "Coins" }));
    await fireEvent.press(within(screen.getByLabelText("Colour")).getByRole("radio", { name: "Teal" }));
    await fireEvent.press(screen.getByRole("button", { name: "Save" }));

    const saved = mockDb.prepare("SELECT * FROM categories WHERE name = 'Bonus'").get() as Record<string, unknown>;
    expect(saved).toMatchObject({ type: "income", icon: "coins", color: "#3aa6a0", user_id: "u1", sort_order: 5 });
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Archive but not Delete for a category that a transaction uses", async () => {
    const onClose = jest.fn();
    await render(<CategoryForm id="groceries" platform="ios" onClose={onClose} />);

    expect(screen.getByText("Edit Category")).toBeTruthy();
    expect(screen.getByPlaceholderText("Name").props.value).toBe("Groceries");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Archive" }));
    expect(row("categories", "groceries")?.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(onClose).toHaveBeenCalled();
  });

  it("deletes a category that nothing uses", async () => {
    const onClose = jest.fn();
    await render(<CategoryForm id="travel" platform="ios" onClose={onClose} />);

    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(row("categories", "travel")).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Restore for an archived category", async () => {
    await render(<CategoryForm id="old" platform="ios" onClose={jest.fn()} />);

    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Restore" }));
    expect(row("categories", "old")?.archived_at).toBeNull();
  });
});

describe("AccountsScreen", () => {
  it("shows the Transfer button, the accounts with coloured person icons and the footer hint", async () => {
    const onTransfer = jest.fn();
    const onNew = jest.fn();
    const onOpen = jest.fn();
    await render(<AccountsScreen platform="ios" onOpen={onOpen} onNew={onNew} onTransfer={onTransfer} />);

    expect(listTitles()).toEqual(["Bank", "Wallet", "Spare"]);
    expect(screen.getByTestId("account-icon-bank").props.color).toBe("#1d4f9a");
    expect(screen.getByTestId("account-icon-wallet").props.color).toBe("#8a5a44");
    expect(
      screen.getByText(
        "You can use accounts to split expenses, for example per bank card, or keep a separate 'Savings' account.",
      ),
    ).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Transfer" }));
    expect(onTransfer).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "New account" }));
    expect(onNew).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Wallet" }));
    expect(onOpen).toHaveBeenCalledWith("wallet");
  });

  it("reorders accounts with a long-press and a drag", async () => {
    await render(<AccountsScreen platform="ios" onOpen={jest.fn()} onNew={jest.fn()} onTransfer={jest.fn()} />);

    await fireEvent(screen.getByRole("button", { name: "Spare" }), "longPress");
    const item = screen.getByTestId("reorder-spare");
    await fireEvent(item, "responderGrant", { nativeEvent: { pageY: 300 } });
    await fireEvent(item, "responderRelease", { nativeEvent: { pageY: 190 } });

    expect(sortOrders("accounts", ["spare", "bank", "wallet"])).toEqual([0, 1, 2]);
  });

  it("shows archived accounts in a collapsed section with Restore", async () => {
    await render(<AccountsScreen platform="ios" onOpen={jest.fn()} onNew={jest.fn()} onTransfer={jest.fn()} />);

    await fireEvent.press(screen.getByRole("button", { name: "Archived (1)" }));
    await fireEvent.press(screen.getByRole("button", { name: "Restore Closed" }));

    expect(row("accounts", "closed")?.archived_at).toBeNull();
  });
});

describe("AccountForm", () => {
  it("creates an account with a name and a colour", async () => {
    const onClose = jest.fn();
    await render(<AccountForm id={null} platform="ios" onClose={onClose} />);

    expect(screen.getByText("New Account")).toBeTruthy();
    expect(within(screen.getByLabelText("Colour")).getAllByRole("radio")).toHaveLength(12);

    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Revolut");
    await fireEvent.press(within(screen.getByLabelText("Colour")).getByRole("radio", { name: "Pink" }));
    await fireEvent.press(screen.getByRole("button", { name: "Save" }));

    const saved = mockDb.prepare("SELECT * FROM accounts WHERE name = 'Revolut'").get() as Record<string, unknown>;
    expect(saved).toMatchObject({ color: "#d6457a", user_id: "u1", sort_order: 4 });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the rejected data of a sync problem, and a save removes the problem", async () => {
    loadFixture(mockDb, {
      sync_problems: [
        {
          id: "p1",
          table_name: "accounts",
          record_id: "gone",
          op: "PUT",
          data_json: JSON.stringify({ user_id: "u1", name: "x".repeat(200), color: "#8a5a44", sort_order: 5 }),
          code: "invalid_record",
          message: "name is too long",
          created_at: "2026-10-19T10:00:00Z",
        },
      ],
    });
    const onClose = jest.fn();
    await render(<AccountForm id="gone" problemId="p1" platform="ios" onClose={onClose} />);

    expect(screen.getByText("Edit Account")).toBeTruthy();
    expect(screen.getByPlaceholderText("Name").props.value).toBe("x".repeat(200));
    await fireEvent.changeText(screen.getByPlaceholderText("Name"), "Savings");
    await fireEvent.press(screen.getByRole("button", { name: "Save" }));

    expect(row("accounts", "gone")).toMatchObject({ name: "Savings", sort_order: 5 });
    expect(mockDb.prepare("SELECT id FROM sync_problems").all()).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Archive but not Delete for an account that a transaction uses", async () => {
    const onClose = jest.fn();
    await render(<AccountForm id="bank" platform="ios" onClose={onClose} />);

    expect(screen.getByText("Edit Account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Archive" }));

    expect(row("accounts", "bank")?.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(onClose).toHaveBeenCalled();
  });

  it("deletes an account that nothing uses", async () => {
    const onClose = jest.fn();
    await render(<AccountForm id="spare" platform="ios" onClose={onClose} />);

    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(row("accounts", "spare")).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });
});
