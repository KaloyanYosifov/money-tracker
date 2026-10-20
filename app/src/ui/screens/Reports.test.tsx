import { StyleSheet } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import { PAGES } from "../nav/TabBar";
import { colors } from "../theme";
import { Reports, reportsReplacesPage } from "./Reports";

let mockDb: TestDatabase;

// The hooks run their SQL against the in-memory fixture database.
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) => ({
    data: mockDb.prepare(sql).all(parameters),
    isLoading: false,
  }),
}));

const october = { start: "2026-10-01", end: "2026-10-31" };
const periodSettings = { week_start_day: 1, month_start_day: 1, year_start_month: 1 };

const userSettings = {
  id: "s1",
  user_id: "u1",
  currency_code: "EUR",
  time_period: "monthly",
  week_start_day: 1,
  month_start_day: 1,
  year_start_month: 1,
  budget_mode: false,
  carry_over: false,
  hide_future: false,
  show_note: true,
  theme: "light",
  summary_font: "mono",
  icon_style: "filled",
};

function category(id: string, name: string, type = "expense") {
  return { id, user_id: "u1", type, name, icon: "tag", color: "#3fb950", sort_order: 0 };
}

const categories = [
  category("salary", "Salary", "income"),
  category("groceries", "Groceries"),
  category("rent", "Rent"),
  category("shopping", "Shopping"),
  category("bills", "Bills"),
  category("fun", "Fun"),
  category("gifts", "Gifts"),
  category("tax", "Tax"),
];

let seq = 0;
function tx(type: string, amount_minor: number, date: string, category_id: string) {
  seq += 1;
  return {
    id: `t${seq}`,
    user_id: "u1",
    type,
    amount_minor,
    currency_code: "EUR",
    date,
    name: "",
    account_id: "bank",
    category_id,
    source: "manual",
  };
}

const transactions = [
  // October: expenses of 1,000.00. Gifts (4 %) and Tax (2 %) are below 5 %.
  tx("expense", 40000, "2026-10-02", "groceries"),
  tx("expense", 30000, "2026-10-03", "rent"),
  tx("expense", 10000, "2026-10-04", "shopping"),
  tx("expense", 8000, "2026-10-05", "bills"),
  tx("expense", 6000, "2026-10-06", "fun"),
  tx("expense", 4000, "2026-10-07", "gifts"),
  tx("expense", 2000, "2026-10-08", "tax"),
  tx("income", 250000, "2026-10-01", "salary"),
  // September.
  tx("income", 300000, "2026-09-01", "salary"),
  tx("expense", 50000, "2026-09-10", "rent"),
  // February is outside the last 8 months.
  tx("income", 999900, "2026-02-01", "salary"),
];

beforeEach(() => {
  mockDb = createTestDatabase();
  loadFixture(mockDb, {
    user_settings: [userSettings],
    accounts: [{ id: "bank", user_id: "u1", name: "Bank", color: "#000000", sort_order: 0 }],
    categories,
    transactions,
  });
});

function renderReports(props: Partial<Parameters<typeof Reports>[0]> = {}) {
  return render(
    <Reports
      period={october}
      kind="monthly"
      settings={periodSettings}
      locale="en-GB"
      today="2026-10-19"
      onShift={jest.fn()}
      onCategoryPress={jest.fn()}
      {...props}
    />,
  );
}

describe("Reports", () => {
  it("switches between Categories and Cash Flow", async () => {
    await renderReports();
    const categoriesTab = screen.getByRole("tab", { name: "Categories" });
    const cashFlowTab = screen.getByRole("tab", { name: "Cash Flow" });
    expect(categoriesTab.props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId("pie-chart")).toBeTruthy();
    expect(screen.queryByTestId("cash-flow-chart")).toBeNull();

    await fireEvent.press(cashFlowTab);
    expect(screen.getByTestId("cash-flow-chart")).toBeTruthy();
    expect(screen.queryByTestId("pie-chart")).toBeNull();
  });

  it("draws the pie with shaded slices, a legend and labels above 5 %", async () => {
    await renderReports();
    for (const id of ["groceries", "rent", "shopping", "bills", "fun", "gifts", "tax"]) {
      const slice = screen.getByTestId(`pie-slice-${id}`);
      expect(slice.props.fill).toEqual({ type: 1, brushRef: `pie-shade-${id}` });
    }

    const legend = screen.getAllByTestId("pie-legend-item").map((item) => item.props.accessibilityLabel);
    expect(legend).toEqual([
      "Groceries, 400 euro, 40%",
      "Rent, 300 euro, 30%",
      "Shopping, 100 euro, 10%",
      "Bills, 80 euro, 8%",
      "Fun, 60 euro, 6%",
      "Gifts, 40 euro, 4%",
      "Tax, 20 euro, 2%",
    ]);

    const labels = screen.getAllByTestId("pie-percent", { includeHiddenElements: true }).map((label) => label.props.children);
    expect(labels).toEqual(["40%", "30%", "10%", "8%", "6%"]);
  });

  it("sums up the top five categories and the others in text", async () => {
    await renderReports();
    expect(screen.getByTestId("pie-summary").props.children).toBe(
      "Top categories: Groceries 40%, Rent 30%, Shopping 10%, Bills 8%, Fun 6%, others 6%.",
    );
  });

  it("shows an empty state when the period has no expenses", async () => {
    await renderReports({ period: { start: "2026-11-01", end: "2026-11-30" } });
    expect(screen.getByText("No expenses in this period")).toBeTruthy();
    expect(screen.queryByTestId("pie-chart")).toBeNull();
  });

  it("opens Transactions for a slice or a legend item", async () => {
    const onCategoryPress = jest.fn();
    await renderReports({ onCategoryPress });
    await fireEvent.press(screen.getByTestId("pie-slice-groceries"));
    expect(onCategoryPress).toHaveBeenCalledWith("groceries");

    await fireEvent.press(screen.getByRole("button", { name: "Rent, 300 euro, 30%" }));
    expect(onCategoryPress).toHaveBeenLastCalledWith("rent");
  });

  it("draws income and expense lines for the last 8 periods", async () => {
    await renderReports();
    await fireEvent.press(screen.getByRole("tab", { name: "Cash Flow" }));

    expect(screen.getByTestId("cash-flow-income")).toBeTruthy();
    expect(screen.getByTestId("cash-flow-expense")).toBeTruthy();
    const points = screen.getAllByRole("button").filter((b) => /^cash-flow-point-/.test(b.props.testID ?? ""));
    expect(points).toHaveLength(8);
    expect(screen.getByText("March")).toBeTruthy();
    expect(screen.getAllByText("October").length).toBeGreaterThan(1);
    expect(screen.queryByTestId("cash-flow-pills")).toBeNull();
  });

  it("shows both values of a tapped point in two pills", async () => {
    await renderReports();
    await fireEvent.press(screen.getByRole("tab", { name: "Cash Flow" }));

    await fireEvent.press(screen.getByTestId("cash-flow-point-6"));
    expect(screen.getByTestId("cash-flow-pills")).toBeTruthy();
    expect(screen.getByText("September")).toBeTruthy();
    expect(screen.getByText("Income €3,000.00")).toBeTruthy();
    expect(screen.getByText("Expense €500.00")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("cash-flow-point-7"));
    expect(screen.getByText("Income €2,500.00")).toBeTruthy();
    expect(screen.getByText("Expense €1,000.00")).toBeTruthy();
  });

  it("moves the period with ◀ and ▶", async () => {
    const onShift = jest.fn();
    await renderReports({ onShift });
    expect(screen.getAllByText("October").length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByRole("button", { name: "Previous period" }));
    await fireEvent.press(screen.getByRole("button", { name: "Next period" }));
    expect(onShift.mock.calls).toEqual([[-1], [1]]);
  });

  it("leaves out ◀ and ▶ when the page header has them", async () => {
    await renderReports({ showPeriodNav: false });
    expect(screen.queryByRole("button", { name: "Previous period" })).toBeNull();
  });

  it("uses a dark full screen background in phone landscape", async () => {
    await renderReports({ variant: "landscape" });
    const style = StyleSheet.flatten(screen.getByTestId("reports").props.style);
    expect(style.backgroundColor).toBe(colors.light.chalkBackground);
    expect(style.flex).toBe(1);

    await renderReports();
    const pageStyle = StyleSheet.flatten(screen.getByTestId("reports").props.style);
    expect(pageStyle.backgroundColor).toBe(colors.light.row);
  });
});

describe("reportsReplacesPage", () => {
  it("replaces Spending and Transactions in phone landscape only", () => {
    expect(reportsReplacesPage("phoneLandscape", "spending")).toBe(true);
    expect(reportsReplacesPage("phoneLandscape", "transactions")).toBe(true);
    expect(reportsReplacesPage("phoneLandscape", "categories")).toBe(false);
    expect(reportsReplacesPage("tabs", "spending")).toBe(false);
    expect(reportsReplacesPage("sidebar", "transactions")).toBe(false);
  });

  it("is page 5 in the browser", () => {
    expect(PAGES[4]).toMatchObject({ name: "reports", title: "Reports" });
  });
});
