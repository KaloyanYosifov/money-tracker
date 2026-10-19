import { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";

import { periodLabel, type Period, type PeriodKind, type PeriodSettings } from "../../domain/period";
import { colors, type ThemeColors } from "../theme";
import { PeriodPicker } from "./PeriodPicker";

type Props = {
  period: Period;
  kind: PeriodKind;
  settings: PeriodSettings;
  onChange: (kind: PeriodKind, period: Period) => void;
  locale?: string;
  today?: string;
  theme?: ThemeColors;
};

/** The period label in the header. A press opens the PeriodPicker. */
export function PeriodPill({ period, kind, settings, onChange, locale, today, theme = colors.light }: Props) {
  const [open, setOpen] = useState(false);
  const label = periodLabel(period, kind, locale, today);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Period, ${label}`}
        onPress={() => setOpen(true)}
        style={[styles.pill, { borderColor: theme.ink, backgroundColor: theme.row }]}
      >
        <Text allowFontScaling style={[styles.label, { color: theme.ink }]}>
          {label}
        </Text>
      </Pressable>
      <PeriodPicker
        key={open ? "open" : "closed"}
        visible={open}
        kind={kind}
        period={period}
        settings={settings}
        today={today}
        theme={theme}
        onClose={() => setOpen(false)}
        onSelect={(nextKind, nextPeriod) => {
          setOpen(false);
          onChange(nextKind, nextPeriod);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    borderWidth: 2,
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: 14,
  },
  label: {
    fontSize: 16,
  },
});
