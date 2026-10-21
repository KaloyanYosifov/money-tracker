import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, type ThemeColors } from "../theme";
import { isHovered } from "./interaction";

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  theme?: ThemeColors;
};

export function SegmentedControl<T extends string>({ options, value, onChange, theme = colors.light }: Props<T>) {
  return (
    <View accessibilityRole="tablist" style={[styles.container, { borderColor: theme.accent }]}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }} aria-selected={selected}
            onPress={() => onChange(option.value)}
            style={(state) => [
              styles.item,
              selected ? { backgroundColor: theme.accent } : isHovered(state) || state.pressed ? { backgroundColor: theme.hover } : null,
            ]}
          >
            <Text allowFontScaling style={[styles.label, { color: selected ? theme.paper : theme.accent }]}>
              {option.label.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignSelf: "center",
    borderWidth: 1.5,
    borderRadius: 5,
    overflow: "hidden",
  },
  item: {
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  label: {
    fontSize: 13,
    fontWeight: "500",
    letterSpacing: 1.5,
  },
});
