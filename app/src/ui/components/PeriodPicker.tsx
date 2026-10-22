import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { periodFor, today as currentDay, type Period, type PeriodKind, type PeriodSettings } from "../../domain/period";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { colors, type ThemeColors } from "../theme";
import { useCloseWithOverlays } from "../overlays";
import { DateField } from "./DateField";

type Props = {
  visible: boolean;
  kind: PeriodKind;
  period: Period;
  settings: PeriodSettings;
  onSelect: (kind: PeriodKind, period: Period) => void;
  onClose: () => void;
  today?: string;
  /** Opens with the From and To fields of the custom range in view. */
  initialCustom?: boolean;
  theme?: ThemeColors;
};

const options: { kind: Exclude<PeriodKind, "custom" | "daily" | "biweekly">; label: string }[] = [
  { kind: "weekly", label: "Week" },
  { kind: "monthly", label: "Month" },
  { kind: "yearly", label: "Year" },
];

/** The day that a change of the kind keeps in view: today if it is in the period, else the first day. */
export function periodAnchor(period: Period, today: string = currentDay()): string {
  return today >= period.start && today <= period.end ? today : period.start;
}

/**
 * Week, Month, Year or a custom range with a From and a To date field.
 * The fields start from `period` when the picker mounts. Remount it (for example with a key) to reset them.
 */
export function PeriodPicker({ visible, kind, period, settings, onSelect, onClose, today, initialCustom = false, theme = colors.light }: Props) {
  const [custom, setCustom] = useState(initialCustom);
  const [from, setFrom] = useState(period.start);
  const [to, setTo] = useState(period.end);
  const [error, setError] = useState<string | null>(null);
  useCloseWithOverlays(visible, onClose);

  const anchor = periodAnchor(period, today);
  // In the wide browser layout the picker is a centred card, like the other cards above the pages.
  const wide = useLayoutMode() === "sidebar";

  function applyCustom() {
    if (from > to) {
      setError("From must be on or before To.");
    } else {
      onSelect("custom", { start: from, end: to });
    }
  }

  const itemStyle = [styles.item, { borderBottomColor: theme.line }];
  const itemText = (label: string, selected: boolean) => (
    <>
      <Text allowFontScaling style={[styles.itemText, { color: theme.ink }, selected && styles.itemTextOn]}>
        {label}
      </Text>
      {selected ? (
        <Text allowFontScaling style={[styles.itemText, { color: theme.accent }]}>
          ✓
        </Text>
      ) : null}
    </>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.root, wide && styles.rootWide]}>
        <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
        <View style={[wide ? styles.card : styles.sheet, { backgroundColor: theme.row }]}>
          <Text allowFontScaling accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>
            Period
          </Text>
          {options.map((option) => (
            <Pressable
              key={option.kind}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: option.kind === kind }} aria-selected={option.kind === kind}
              onPress={() => onSelect(option.kind, periodFor(anchor, option.kind, settings))}
              style={itemStyle}
            >
              {itemText(option.label, option.kind === kind)}
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Custom"
            accessibilityState={{ selected: kind === "custom", expanded: custom }} aria-selected={kind === "custom"} aria-expanded={custom}
            onPress={() => setCustom(true)}
            style={itemStyle}
          >
            {itemText("Custom", kind === "custom")}
          </Pressable>
          {custom ? (
            <View>
              {/* The calendars keep From on or before To. */}
              <DateField
                label="From"
                value={from}
                onChange={setFrom}
                maxDate={to}
                weekStartDay={settings.week_start_day}
                today={today}
                theme={theme}
              />
              <DateField
                label="To"
                value={to}
                onChange={setTo}
                minDate={from}
                weekStartDay={settings.week_start_day}
                today={today}
                theme={theme}
              />
              <View style={styles.custom}>
                {error ? (
                  <Text allowFontScaling accessibilityRole="alert" style={[styles.error, { color: theme.listRed }]}>
                    {error}
                  </Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Apply"
                  onPress={applyCustom}
                  style={[styles.apply, { backgroundColor: theme.accent }]}
                >
                  <Text allowFontScaling style={[styles.applyText, { color: theme.row }]}>
                    Apply
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  rootWide: {
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    marginTop: "auto",
    paddingBottom: 24,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    paddingBottom: 12,
    borderRadius: 8,
    overflow: "hidden",
    shadowColor: "#3c2314",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
    padding: 14,
  },
  item: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  itemText: {
    fontSize: 18,
  },
  itemTextOn: {
    fontWeight: "600",
  },
  custom: {
    padding: 16,
  },
  error: {
    fontSize: 13,
    marginBottom: 10,
  },
  apply: {
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 4,
  },
  applyText: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 1,
  },
});
