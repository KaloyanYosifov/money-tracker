import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

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

  const value = useMemo<PeriodState>(() => {
    const kind = chosen?.kind ?? defaultKind;
    const period = chosen?.period ?? periodFor(today(), defaultKind, settings);
    return {
      kind,
      period,
      settings,
      setPeriod: (nextKind, nextPeriod) => setChosen({ kind: nextKind, period: nextPeriod }),
      shift: (step) => setChosen({ kind, period: shiftPeriod(period, kind, settings, step) }),
    };
  }, [chosen, defaultKind, settings]);

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodState {
  const value = useContext(PeriodContext);
  if (!value) throw new Error("usePeriod needs a PeriodProvider");
  return value;
}
