import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

import { PeriodProvider, usePeriod } from "./PeriodContext";

const SETTINGS = { week_start_day: 1, month_start_day: 1, year_start_month: 1 };

describe("PeriodProvider", () => {
  let listeners: ((state: AppStateStatus) => void)[];

  beforeEach(() => {
    listeners = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      listeners.push(listener as (state: AppStateStatus) => void);
      return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
    });
    jest.useFakeTimers({ now: new Date(2026, 9, 31, 23, 50) });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("moves to the new current period when the app comes back on a later day", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PeriodProvider settings={SETTINGS} defaultKind="monthly">
        {children}
      </PeriodProvider>
    );
    const { result } = await renderHook(() => usePeriod(), { wrapper });
    expect(result.current.period.start).toBe("2026-10-01");

    jest.setSystemTime(new Date(2026, 10, 1, 8, 0));
    await act(async () => listeners.forEach((listener) => listener("active")));

    expect(result.current.period.start).toBe("2026-11-01");
  });
  it("goes back to the current period when the start settings change", async () => {
    let settings = SETTINGS;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PeriodProvider settings={settings} defaultKind="monthly">
        {children}
      </PeriodProvider>
    );
    const { result, rerender } = await renderHook(() => usePeriod(), { wrapper });
    await act(async () => result.current.shift(-1));
    expect(result.current.period).toEqual({ start: "2026-09-01", end: "2026-09-30" });

    settings = { ...SETTINGS, month_start_day: 25 };
    await rerender({});

    expect(result.current.period).toEqual({ start: "2026-10-25", end: "2026-11-24" });
  });
});
