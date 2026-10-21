import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { periodFor, today as currentDay, type Period, type PeriodKind, type PeriodSettings } from "../../domain/period";
import { isDate } from "../../domain/validation";
import { colors, type ThemeColors } from "../theme";

type Props = {
  visible: boolean;
  kind: PeriodKind;
  period: Period;
  settings: PeriodSettings;
  onSelect: (kind: PeriodKind, period: Period) => void;
  onClose: () => void;
  today?: string;
  theme?: ThemeColors;
};

const options: { kind: Exclude<PeriodKind, "custom" | "daily" | "biweekly">; label: string }[] = [
  { kind: "weekly", label: "Week" },
  { kind: "monthly", label: "Month" },
  { kind: "yearly", label: "Year" },
];

/**
 * Week, Month, Year or a custom range with two YYYY-MM-DD fields.
 * The fields start from `period` when the picker mounts. Remount it (for example with a key) to reset them.
 */
export function PeriodPicker({ visible, kind, period, settings, onSelect, onClose, today, theme = colors.light }: Props) {
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(period.start);
  const [to, setTo] = useState(period.end);
  const [error, setError] = useState<string | null>(null);

  const day = today ?? currentDay();
  // Keep the shown period in view: use today if it is in the period, else the first day.
  const anchor = day >= period.start && day <= period.end ? day : period.start;

  function applyCustom() {
    if (!isDate(from) || !isDate(to)) {
      setError("Enter the dates as YYYY-MM-DD.");
    } else if (from > to) {
      setError("From must be on or before To.");
    } else {
      onSelect("custom", { start: from, end: to });
    }
  }

  const itemStyle = [styles.item, { borderBottomColor: theme.line }];
  const textStyle = [styles.itemText, { color: theme.ink }];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: theme.row }]}>
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
            <Text allowFontScaling style={textStyle}>
              {option.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Custom"
          accessibilityState={{ selected: kind === "custom", expanded: custom }} aria-selected={kind === "custom"} aria-expanded={custom}
          onPress={() => setCustom(true)}
          style={itemStyle}
        >
          <Text allowFontScaling style={textStyle}>
            Custom
          </Text>
        </Pressable>
        {custom ? (
          <View style={styles.custom}>
            {(
              [
                ["From", from, setFrom],
                ["To", to, setTo],
              ] as const
            ).map(([label, value, setValue]) => (
              <View key={label} style={styles.field}>
                <Text allowFontScaling style={[styles.fieldLabel, { color: theme.accent }]}>
                  {label}
                </Text>
                <TextInput
                  accessibilityLabel={label}
                  allowFontScaling
                  value={value}
                  onChangeText={setValue}
                  placeholder="YYYY-MM-DD"
                  autoCapitalize="none"
                  autoCorrect={false}
                  inputMode="numeric"
                  style={[styles.input, { color: theme.ink, borderColor: theme.line }]}
                />
              </View>
            ))}
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
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  title: {
    fontSize: 15,
    fontWeight: "600",
    padding: 14,
  },
  item: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  itemText: {
    fontSize: 18,
  },
  custom: {
    padding: 16,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  fieldLabel: {
    width: 60,
    fontSize: 13,
  },
  input: {
    flex: 1,
    fontSize: 16,
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: 10,
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
