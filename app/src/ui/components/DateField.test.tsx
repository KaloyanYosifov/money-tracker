import { StyleSheet } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { closeOverlays } from "../overlays";
import { colors } from "../theme";
import {
  addDays,
  addMonths,
  calendarKey,
  CalendarSheet,
  dateFieldLabel,
  DateField,
  dayAccessibilityLabel,
  monthGrid,
} from "./DateField";

const TODAY = "2026-10-22";
const locale = "en-GB";

function flatStyle(element: { props: { style?: unknown } }) {
  return StyleSheet.flatten(element.props.style as never) ?? {};
}

async function renderSheet(props: Partial<Parameters<typeof CalendarSheet>[0]> = {}) {
  const onChange = jest.fn();
  const onClose = jest.fn();
  const result = await render(
    <CalendarSheet
      visible
      value="2026-10-15"
      onChange={onChange}
      onClose={onClose}
      weekStartDay={1}
      locale={locale}
      today={TODAY}
      {...props}
    />,
  );
  return { onChange, onClose, result };
}

const monthTitle = () => screen.getByRole("header", { name: /^\w+ \d{4}$/ });

describe("date helpers", () => {
  it("adds days across months, years and leap days", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2023-02-28", 1)).toBe("2023-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    // Daylight saving changes in Europe and the US have no effect.
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
  });

  it("moves to the first day of other months", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-31", -1)).toBe("2025-12-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("builds a 6-week grid from the week start", () => {
    // 1 October 2026 is a Thursday.
    const monday = monthGrid("2026-10-01", 1);
    expect(monday).toHaveLength(42);
    expect(monday[0]).toBe("2026-09-28");
    expect(monday[41]).toBe("2026-11-08");
    expect(monthGrid("2026-10-01", 0)[0]).toBe("2026-09-27");
    expect(monthGrid("2026-10-01", 4)[0]).toBe("2026-10-01");
    // February 2026 starts on a Sunday.
    expect(monthGrid("2026-02-01", 0)[0]).toBe("2026-02-01");
    expect(monthGrid("2026-02-01", 1)[0]).toBe("2026-01-26");
  });

  it("labels Today, Yesterday and other days", () => {
    expect(dateFieldLabel(TODAY, locale, TODAY)).toBe("Today");
    expect(dateFieldLabel("2026-10-21", locale, TODAY)).toBe("Yesterday");
    expect(dateFieldLabel("2026-10-20", locale, TODAY)).toBe("Tue, 20 Oct 2026");
    expect(dateFieldLabel("2027-01-01", locale, TODAY)).toBe("Fri, 1 Jan 2027");
    expect(dateFieldLabel("2026-12-31", locale, "2027-01-01")).toBe("Yesterday");
    expect(dayAccessibilityLabel(TODAY, locale)).toBe("22 October 2026");
  });

  it("maps keys to calendar actions", () => {
    expect(calendarKey("Escape", TODAY)).toEqual({ type: "close" });
    expect(calendarKey("Enter", TODAY)).toEqual({ type: "select", date: TODAY });
    expect(calendarKey("ArrowLeft", TODAY)).toEqual({ type: "move", date: "2026-10-21" });
    expect(calendarKey("ArrowRight", "2026-10-31")).toEqual({ type: "move", date: "2026-11-01" });
    expect(calendarKey("ArrowUp", TODAY)).toEqual({ type: "move", date: "2026-10-15" });
    expect(calendarKey("ArrowDown", TODAY)).toEqual({ type: "move", date: "2026-10-29" });
    expect(calendarKey("ArrowRight", TODAY, undefined, TODAY)).toBeNull();
    expect(calendarKey("Enter", "2026-10-01", "2026-10-05")).toBeNull();
    expect(calendarKey("a", TODAY)).toBeNull();
  });
});

describe("CalendarSheet", () => {
  it("closes when the app closes the overlays at the end of the session", async () => {
    const { onClose } = await renderSheet();
    await act(async () => {
      closeOverlays();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the month of the value with the week start first", async () => {
    await renderSheet();
    expect(monthTitle()).toHaveTextContent("October 2026");
    expect(screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/).map((node) => node.props.children)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
  });

  it("starts the week on Sunday for week_start_day 0", async () => {
    await renderSheet({ weekStartDay: 0 });
    const names = screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/).map((node) => node.props.children);
    expect(names[0]).toBe("Sun");
    expect(names[6]).toBe("Sat");
    expect(screen.getAllByRole("button", { name: /\d{4}$/ })[0]).toHaveAccessibleName("27 September 2026");
  });

  it("opens at the month of today when the value is empty", async () => {
    await renderSheet({ value: "" });
    expect(monthTitle()).toHaveTextContent("October 2026");
    expect(screen.getByRole("button", { name: "22 October 2026", selected: false })).toBeTruthy();
  });

  it("navigates across the year boundary both ways", async () => {
    await renderSheet({ value: "2026-12-10" });
    expect(monthTitle()).toHaveTextContent("December 2026");
    await fireEvent.press(screen.getByRole("button", { name: "Next month" }));
    expect(monthTitle()).toHaveTextContent("January 2027");
    expect(screen.getByRole("button", { name: "31 January 2027" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Previous month" }));
    await fireEvent.press(screen.getByRole("button", { name: "Previous month" }));
    await fireEvent.press(screen.getByRole("button", { name: "Previous month" }));
    await fireEvent.press(screen.getByRole("button", { name: "Previous month" }));
    expect(monthTitle()).toHaveTextContent("September 2026");
  });

  it("shows 29 February in a leap year only", async () => {
    await renderSheet({ value: "2024-02-10" });
    expect(screen.getByRole("button", { name: "29 February 2024" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 March 2024" })).toBeTruthy();
    for (let i = 0; i < 12; i++) await fireEvent.press(screen.getByRole("button", { name: "Next month" }));
    expect(monthTitle()).toHaveTextContent("February 2025");
    expect(screen.queryByRole("button", { name: "29 February 2025" })).toBeNull();
    expect(screen.getByRole("button", { name: "28 February 2025" })).toBeTruthy();
  });

  it("marks the selected day and today", async () => {
    await renderSheet();
    expect(screen.getByRole("button", { name: "15 October 2026", selected: true })).toBeTruthy();
    expect(screen.getAllByRole("button", { selected: true })).toHaveLength(1);
    expect(flatStyle(screen.getByTestId("day-2026-10-15-mark")).backgroundColor).toBe(colors.light.accent);
    expect(flatStyle(screen.getByTestId("day-2026-10-22-mark")).borderColor).toBe(colors.light.accent);
    expect(flatStyle(screen.getByTestId("day-2026-10-22-mark")).backgroundColor).toBeUndefined();
    expect(screen.getByTestId("day-2026-10-22").props.accessibilityHint).toBe("Today");
  });

  it("selects a day, also from the next month, and closes", async () => {
    const { onChange, onClose } = await renderSheet();
    await fireEvent.press(screen.getByRole("button", { name: "3 October 2026" }));
    expect(onChange).toHaveBeenCalledWith("2026-10-03");
    expect(onClose).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "2 November 2026" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-11-02");
  });

  it("selects Today and Yesterday from the chips", async () => {
    const { onChange, onClose } = await renderSheet();
    await fireEvent.press(screen.getByRole("button", { name: "Today" }));
    expect(onChange).toHaveBeenLastCalledWith(TODAY);
    await fireEvent.press(screen.getByRole("button", { name: "Yesterday" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-21");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("disables days and months outside min and max", async () => {
    const { onChange } = await renderSheet({ minDate: "2026-10-10", maxDate: "2026-10-21" });
    expect(screen.getByRole("button", { name: "9 October 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "22 October 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "10 October 2026" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Yesterday" })).toBeEnabled();
    await fireEvent.press(screen.getByRole("button", { name: "9 October 2026" }));
    await fireEvent.press(screen.getByRole("button", { name: "Today" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("allows navigation to a month that is partly in range", async () => {
    await renderSheet({ value: "2026-10-15", minDate: "2026-09-30" });
    expect(screen.getByRole("button", { name: "Previous month" })).toBeEnabled();
    await fireEvent.press(screen.getByRole("button", { name: "Previous month" }));
    expect(monthTitle()).toHaveTextContent("September 2026");
    expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
  });

  it("opens at the min date when the value is empty and today is before it", async () => {
    await renderSheet({ value: "", minDate: "2027-03-05" });
    expect(monthTitle()).toHaveTextContent("March 2027");
  });

  it("closes with Cancel without a change", async () => {
    const { onChange, onClose } = await renderSheet();
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns to the month of the value when it opens again", async () => {
    const { result } = await renderSheet();
    await fireEvent.press(screen.getByRole("button", { name: "Next month" }));
    expect(monthTitle()).toHaveTextContent("November 2026");
    const props = { value: "2026-10-15", onChange: jest.fn(), onClose: jest.fn(), locale, today: TODAY };
    await result.rerender(<CalendarSheet visible={false} {...props} />);
    await result.rerender(<CalendarSheet visible {...props} />);
    expect(monthTitle()).toHaveTextContent("October 2026");
  });

  it("keeps the bottom sheet clear of the home indicator and narrow on a tablet", async () => {
    const insets = { top: 0, right: 0, bottom: 34, left: 0 };
    await render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <CalendarSheet visible value="2026-10-15" onChange={jest.fn()} onClose={jest.fn()} locale={locale} today={TODAY} />
      </SafeAreaInsetsContext.Provider>,
    );
    const sheet = screen.getByRole("header", { name: "Date" }).parent!;
    expect(flatStyle(sheet)).toEqual(
      expect.objectContaining({ paddingBottom: 34, width: "100%", maxWidth: 520, alignSelf: "center" }),
    );
  });
});

describe("DateField", () => {
  it("shows Today, Yesterday or the date", async () => {
    const { rerender } = await render(<DateField value={TODAY} onChange={jest.fn()} locale={locale} today={TODAY} label="Date" />);
    expect(screen.getByRole("button", { name: "Date, Today" })).toBeTruthy();
    await rerender(<DateField value="2026-10-21" onChange={jest.fn()} locale={locale} today={TODAY} label="Date" />);
    expect(screen.getByText("Yesterday")).toBeTruthy();
    await rerender(<DateField value="2026-10-01" onChange={jest.fn()} locale={locale} today={TODAY} label="Date" />);
    expect(screen.getByText("Thu, 1 Oct 2026")).toBeTruthy();
  });

  it("opens the calendar and reports the selected day", async () => {
    const onChange = jest.fn();
    const onOpenChange = jest.fn();
    await render(
      <DateField
        value="2026-10-15"
        onChange={onChange}
        onOpenChange={onOpenChange}
        locale={locale}
        today={TODAY}
        accessibilityLabel="Date"
        testID="date-field"
      />,
    );
    expect(screen.queryByRole("button", { name: "Next month" })).toBeNull();
    await fireEvent.press(screen.getByTestId("date-field"));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await fireEvent.press(screen.getByRole("button", { name: "20 October 2026" }));
    expect(onChange).toHaveBeenCalledWith("2026-10-20");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("button", { name: "Next month" })).toBeNull();
  });

  it("passes min and max to the calendar", async () => {
    await render(<DateField value="2026-10-15" onChange={jest.fn()} minDate="2026-10-12" locale={locale} today={TODAY} />);
    await fireEvent.press(screen.getByRole("button", { name: /^Date, / }));
    expect(screen.getByRole("button", { name: "11 October 2026" })).toBeDisabled();
  });

  it("shows the placeholder and a Clear action with allowEmpty", async () => {
    const onChange = jest.fn();
    const { rerender } = await render(
      <DateField value="2026-11-30" onChange={onChange} allowEmpty placeholder="Never" label="End Date" locale={locale} today={TODAY} />,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Clear End Date" }));
    expect(onChange).toHaveBeenCalledWith("");

    await rerender(<DateField value="" onChange={onChange} allowEmpty placeholder="Never" label="End Date" locale={locale} today={TODAY} />);
    expect(screen.getByRole("button", { name: "End Date, Never" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear End Date" })).toBeNull();
  });

  it("has no Clear action without allowEmpty", async () => {
    await render(<DateField value={TODAY} onChange={jest.fn()} label="Date" locale={locale} today={TODAY} />);
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
  });

  it("uses None as the default placeholder", async () => {
    await render(<DateField value="" onChange={jest.fn()} allowEmpty label="End Date" locale={locale} today={TODAY} />);
    expect(screen.getByText("None")).toBeTruthy();
  });
});
