import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, type ThemeColors } from "../theme";

type Props = {
  label: string;
  /** The value as text. Use children for an input or a switch. */
  value?: string;
  placeholder?: string;
  children?: ReactNode;
  onPress?: () => void;
  theme?: ThemeColors;
};

/** A label and a value. A row with onPress shows a chevron and opens a picker. */
export function FormRow({ label, value, placeholder, children, onPress, theme = colors.light }: Props) {
  const empty = !value;
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `${label}, ${value || placeholder || ""}` : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={[styles.row, { backgroundColor: theme.row, borderBottomColor: theme.line }]}
    >
      <Text allowFontScaling style={[styles.label, { color: theme.accent }]}>
        {label}
      </Text>
      <View style={styles.value}>
        {children ?? (
          <Text allowFontScaling style={{ fontSize: 16, color: empty ? theme.accent : theme.ink }}>
            {value || placeholder}
          </Text>
        )}
      </View>
      {onPress ? (
        <Text allowFontScaling style={[styles.chevron, { color: theme.line }]}>
          ›
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  label: {
    width: 84,
    fontSize: 13,
  },
  value: {
    flex: 1,
  },
  chevron: {
    fontSize: 20,
    marginLeft: 8,
  },
});
