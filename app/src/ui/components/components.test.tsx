import { StyleSheet } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { TransactionListRow } from "../../data/queries";
import { periodLabel } from "../../domain/period";
import { colors } from "../theme";
import { Banner } from "./Banner";
import { PeriodPill } from "./PeriodPill";
import { SegmentedControl } from "./SegmentedControl";
import { TransactionRow } from "./TransactionRow";
import { UndoToast } from "./UndoToast";

const settings = { week_start_day: 1, month_start_day: 1, year_start_month: 1 };
const october = { start: "2026-10-01", end: "2026-10-31" };

function flatStyle(element: { props: { style?: unknown } }) {
  return StyleSheet.flatten(element.props.style as never) ?? {};
}

describe("PeriodPill", () => {
  it("shows the period label", async () => {
    await render(
      <PeriodPill period={october} kind="monthly" settings={settings} onChange={jest.fn()} locale="en-GB" today="2026-10-19" />,
    );
    expect(screen.getByText(periodLabel(october, "monthly", "en-GB", "2026-10-19"))).toBeTruthy();
  });

  it("opens the picker and selects Week", async () => {
    const onChange = jest.fn();
    await render(
      <PeriodPill period={october} kind="monthly" settings={settings} onChange={onChange} locale="en-GB" today="2026-10-19" />,
    );
    await fireEvent.press(screen.getByRole("button", { name: /period/i }));
    for (const option of ["Week", "Month", "Year", "Custom"]) {
      expect(screen.getByText(option)).toBeTruthy();
    }
    await fireEvent.press(screen.getByText("Week"));
    expect(onChange).toHaveBeenCalledWith("weekly", { start: "2026-10-19", end: "2026-10-25" });
  });

  it("selects a custom range from two date fields", async () => {
    const onChange = jest.fn();
    await render(
      <PeriodPill period={october} kind="monthly" settings={settings} onChange={onChange} locale="en-GB" today="2026-10-19" />,
    );
    await fireEvent.press(screen.getByRole("button", { name: /period/i }));
    await fireEvent.press(screen.getByText("Custom"));
    await fireEvent.changeText(screen.getByLabelText("From"), "2026-10-05");
    await fireEvent.changeText(screen.getByLabelText("To"), "2026-10-02");
    await fireEvent.press(screen.getByText("Apply"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/From must be on or before To/)).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("To"), "2026-10-12");
    await fireEvent.press(screen.getByText("Apply"));
    expect(onChange).toHaveBeenCalledWith("custom", { start: "2026-10-05", end: "2026-10-12" });
  });
});

describe("SegmentedControl", () => {
  it("reports its selection and has tab items", async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl
        options={[
          { value: "expense", label: "Expense" },
          { value: "income", label: "Income" },
        ]}
        value="expense"
        onChange={onChange}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Expense", selected: true })).toBeTruthy();
    await fireEvent.press(screen.getByRole("tab", { name: "Income" }));
    expect(onChange).toHaveBeenCalledWith("income");
  });
});

function txRow(overrides: Partial<TransactionListRow>): TransactionListRow {
  return {
    id: "t1",
    kind: "transaction",
    type: "expense",
    amount_minor: 1499,
    currency_code: "EUR",
    date: "2026-10-01",
    name: "Feather insurance",
    note: null,
    category_id: "c1",
    category_name: "Bills",
    category_icon: "calculator",
    category_color: "#2b2420",
    account_id: "a1",
    account_name: "Revolut euro",
    to_account_id: null,
    to_account_name: null,
    recurring_rule_id: null,
    ...overrides,
  };
}

describe("TransactionRow", () => {
  it("shows name, account and date, and a red expense amount", async () => {
    await render(<TransactionRow row={txRow({ recurring_rule_id: "r1" })} locale="en-GB" />);
    expect(screen.getByText("Feather insurance")).toBeTruthy();
    expect(screen.getByText("Revolut euro, Thursday, 01 Oct 2026")).toBeTruthy();
    const amount = screen.getByText("€14.99");
    expect(flatStyle(amount).color).toBe(colors.light.listRed);
    expect(screen.getByLabelText(/expense 14 euro 99/)).toBeTruthy();
    expect(screen.getByTestId("repeat-mark")).toBeTruthy();
  });

  it("shows a green income amount and no repeat mark", async () => {
    await render(<TransactionRow row={txRow({ type: "income", amount_minor: 250000, name: "Salary" })} locale="en-GB" />);
    expect(flatStyle(screen.getByText("€2,500.00")).color).toBe(colors.light.listGreen);
    expect(screen.getByLabelText(/income 2500 euro/)).toBeTruthy();
    expect(screen.queryByTestId("repeat-mark")).toBeNull();
  });

  it("uses the peach style for Carry Over", async () => {
    await render(
      <TransactionRow
        row={txRow({ kind: "carryOver", type: "income", amount_minor: 6765, name: "Carry Over", account_name: "Wallet Euro", category_icon: null })}
        locale="en-GB"
      />,
    );
    expect(flatStyle(screen.getByTestId("transaction-row")).backgroundColor).toBe(colors.light.carryOver);
    expect(flatStyle(screen.getByText("€67.65")).color).toBe(colors.light.listGreen);
    expect(screen.getByLabelText(/carry over 67 euro 65/)).toBeTruthy();
  });

  it("says minus for a negative Carry Over", async () => {
    await render(
      <TransactionRow row={txRow({ kind: "carryOver", type: "income", amount_minor: -500, name: "Carry Over" })} locale="en-GB" />,
    );
    expect(flatStyle(screen.getByText("-€5.00")).color).toBe(colors.light.listRed);
    expect(screen.getByLabelText(/carry over minus 5 euro/)).toBeTruthy();
  });
});

describe("Banner", () => {
  it("renders the title, the text and an action button", async () => {
    const onAction = jest.fn();
    await render(
      <Banner title="Needs attention" text="1 change could not sync" actionLabel="Review" onAction={onAction} />,
    );
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("1 change could not sync")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Review" }));
    expect(onAction).toHaveBeenCalled();
  });
});

describe("UndoToast", () => {
  it("shows Deleted · Undo and calls undo", async () => {
    const undo = jest.fn();
    await render(<UndoToast visible onUndo={undo} />);
    await fireEvent.press(screen.getByText("Deleted · Undo"));
    expect(undo).toHaveBeenCalled();
  });

  it("renders nothing when not visible", async () => {
    await render(<UndoToast visible={false} onUndo={jest.fn()} />);
    expect(screen.queryByText("Deleted · Undo")).toBeNull();
  });
});
