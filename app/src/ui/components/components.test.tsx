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

/** The spoken name of a day cell in the test locale, "5 October 2026" or "October 5, 2026". */
function dayName(month: string, day: number): RegExp {
  return new RegExp(`^(${day} ${month} 2026|${month} ${day}, 2026)$`);
}


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
    await fireEvent.press(screen.getByRole("button", { name: /^From, / }));
    await fireEvent.press(screen.getByRole("button", { name: dayName("October", 5) }));
    expect(screen.getByRole("button", { name: /^From, Mon, / })).toBeTruthy();

    // To cannot go before From.
    await fireEvent.press(screen.getByRole("button", { name: /^To, / }));
    expect(screen.getByRole("button", { name: dayName("October", 2) })).toBeDisabled();
    await fireEvent.press(screen.getByRole("button", { name: dayName("October", 12) }));
    expect(onChange).not.toHaveBeenCalled();

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

  it("shows a Carry Over row of type expense as negative", async () => {
    // transactionList returns the absolute balance, with type "expense" for a negative balance.
    await render(
      <TransactionRow row={txRow({ kind: "carryOver", type: "expense", amount_minor: 500, name: "Carry Over" })} locale="en-GB" />,
    );
    expect(flatStyle(screen.getByText("-€5.00")).color).toBe(colors.light.listRed);
    expect(screen.getByLabelText(/carry over minus 5 euro/)).toBeTruthy();
  });

  it.each([
    ["the category name", txRow({ name: "" }), "Bills"],
    ["Transfer for a transfer", txRow({ name: " ", type: "transfer", category_name: null, to_account_name: "Wallet" }), "Transfer"],
    ["the type without a category", txRow({ name: "", type: "income", category_name: null }), "Income"],
  ])("shows %s as the title when the name is empty", async (_, row, title) => {
    await render(<TransactionRow row={row} locale="en-GB" />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByTestId("transaction-row").props.accessibilityLabel).toMatch(new RegExp(`^${title}, `));
  });

  it("shows the note as one line only with showNote", async () => {
    const row = txRow({ note: "Paid with the card" });
    await render(<TransactionRow row={row} locale="en-GB" />);
    expect(screen.queryByText("Paid with the card")).toBeNull();

    await screen.rerender(<TransactionRow row={row} locale="en-GB" showNote />);
    const note = screen.getByTestId("transaction-note-line");
    expect(note.props.children).toBe("Paid with the card");
    expect(note.props.numberOfLines).toBe(1);
    expect(flatStyle(note).color).toBe(colors.light.accent);
    expect(screen.getByTestId("transaction-row").props.accessibilityLabel).toMatch(/, Paid with the card$/);
  });

  it("shows no note line for an empty note", async () => {
    await render(<TransactionRow row={txRow({ note: "  " })} locale="en-GB" showNote />);
    expect(screen.queryByTestId("transaction-note-line")).toBeNull();
  });

  it("limits the name to two lines and the subtitle to one, and centres the amount", async () => {
    await render(<TransactionRow row={txRow({ name: "A very long transaction name ".repeat(4) })} locale="en-GB" />);
    expect(screen.getByText(/A very long/).props.numberOfLines).toBe(2);
    expect(screen.getByText("Revolut euro, Thursday, 01 Oct 2026").props.numberOfLines).toBe(1);
    expect(flatStyle(screen.getByText("€14.99")).alignSelf).toBeUndefined();
  });

  it("shows the transfer icon for a transfer", async () => {
    await render(
      <TransactionRow
        row={txRow({ type: "transfer", category_id: null, category_name: null, category_icon: null, to_account_name: "Wallet" })}
        locale="en-GB"
      />,
    );
    expect(screen.getByTestId("transfer-icon")).toBeTruthy();
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

  it.each(["light", "dark"] as const)("uses the %s theme colours", async (name) => {
    const theme = colors[name];
    await render(<UndoToast visible onUndo={jest.fn()} theme={theme} />);
    expect(flatStyle(screen.getByTestId("undo-toast")).backgroundColor).toBe(theme.ink);
    expect(flatStyle(screen.getByText("Deleted · Undo")).color).toBe(theme.paper);
  });

  it("sits at the given distance from the bottom", async () => {
    await render(<UndoToast visible onUndo={jest.fn()} bottom={80} />);
    expect(flatStyle(screen.getByTestId("undo-toast")).bottom).toBe(80);
  });

  it("renders nothing when not visible", async () => {
    await render(<UndoToast visible={false} onUndo={jest.fn()} />);
    expect(screen.queryByText("Deleted · Undo")).toBeNull();
  });
});
