import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { periodFor, shiftPeriod, today, type Period, type PeriodKind, type PeriodSettings } from "../../domain/period";

export interface PeriodState {
  kind: PeriodKind;
  period: Period;
  settings: PeriodSettings;
  setPeriod: (kind: PeriodKind, period: Period) => void;
  /** Moves to the previous (-1) or the next (+1) period. */
  shift: (step: number) => void;
}

const PeriodContext = createContext<PeriodState | null>(null);

type Props = {
  settings: PeriodSettings;
  /** The time period from the user settings. */
  defaultKind: Exclude<PeriodKind, "custom">;
  children: ReactNode;
};

/**
 * The period that the header and the pages share. Until the user picks a
 * period, it follows the current period of the user settings.
 */
export function PeriodProvider({ settings, defaultKind, children }: Props) {
  const [chosen, setChosen] = useState<{ kind: PeriodKind; period: Period } | null>(null);
  // The app can stay open for days, so the current period follows the date each time the app comes back.
  const [day, setDay] = useState(today);
  // A picked period has the dates of the old start settings, so a change of them goes back to the current period.
  const settingsKey = `${defaultKind}:${settings.week_start_day}:${settings.month_start_day}:${settings.year_start_month}`;
  const [chosenFor, setChosenFor] = useState(settingsKey);
  if (chosenFor !== settingsKey) {
    setChosenFor(settingsKey);
    setChosen(null);
  }

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setDay(today());
    });
    return () => subscription.remove();
  }, []);

  const value = useMemo<PeriodState>(() => {
    const kind = chosen?.kind ?? defaultKind;
    const period = chosen?.period ?? periodFor(day, defaultKind, settings);
    return {
      kind,
      period,
      settings,
      setPeriod: (nextKind, nextPeriod) => setChosen({ kind: nextKind, period: nextPeriod }),
      shift: (step) => setChosen({ kind, period: shiftPeriod(period, kind, settings, step) }),
    };
  }, [chosen, day, defaultKind, settings]);

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodState {
  const value = useContext(PeriodContext);
  if (!value) throw new Error("usePeriod needs a PeriodProvider");
  return value;
}
