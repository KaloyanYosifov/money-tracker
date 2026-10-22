import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import type { PeriodKind } from "../../domain/period";
import { PeriodProvider, usePeriod } from "./PeriodContext";
import { SidebarPage } from "./Sidebar";

/** The spoken name of a day cell in the test locale, "5 October 2026" or "October 5, 2026". */
function dayName(month: string, day: number): RegExp {
  return new RegExp(`^(${day} ${month} 2026|${month} ${day}, 2026)$`);
}


const SETTINGS = { week_start_day: 1, month_start_day: 1, year_start_month: 1 };

function Probe() {
  const { kind, period } = usePeriod();
  return <Text testID="probe">{`${kind} ${period.start} ${period.end}`}</Text>;
}

function renderPage(defaultKind: Exclude<PeriodKind, "custom">) {
  return render(
    <PeriodProvider settings={SETTINGS} defaultKind={defaultKind}>
      <SidebarPage routeName="spending" title="Spending">
        <Probe />
      </SidebarPage>
    </PeriodProvider>,
  );
}

describe("SidebarPage period controls", () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date(2026, 9, 22, 12, 0) }));
  afterEach(() => jest.useRealTimers());

  it("goes to the period with today when the kind changes and today is in the current period", async () => {
    await renderPage("yearly");
    await fireEvent.press(screen.getByRole("tab", { name: "W" }));
    expect(screen.getByTestId("probe")).toHaveTextContent("weekly 2026-10-19 2026-10-25");
  });

  it("goes to the period with the first day when today is not in the current period", async () => {
    await renderPage("yearly");
    await fireEvent.press(screen.getByRole("button", { name: "Previous period" }));
    await fireEvent.press(screen.getByRole("tab", { name: "M" }));
    expect(screen.getByTestId("probe")).toHaveTextContent("monthly 2025-01-01 2025-01-31");
  });

  it("opens the custom range fields for Custom and changes the period only on Apply", async () => {
    await renderPage("monthly");
    await fireEvent.press(screen.getByRole("tab", { name: "Custom" }));
    expect(screen.getByTestId("probe")).toHaveTextContent("monthly 2026-10-01 2026-10-31");

    await fireEvent.press(screen.getByRole("button", { name: /^From, / }));
    await fireEvent.press(screen.getByRole("button", { name: "Previous month" }));
    await fireEvent.press(screen.getByRole("button", { name: dayName("September", 15) }));
    await fireEvent.press(screen.getByRole("button", { name: /^To, / }));
    await fireEvent.press(screen.getByRole("button", { name: dayName("October", 14) }));
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Apply" })));
    expect(screen.getByTestId("probe")).toHaveTextContent("custom 2026-09-15 2026-10-14");
  });

  it.each([
    ["daily", "D"],
    ["biweekly", "2W"],
  ] as const)("shows the %s kind of the settings as the selected segment", async (kind, label) => {
    await renderPage(kind);
    expect(screen.getByRole("tab", { name: label })).toBeSelected();
  });
});
