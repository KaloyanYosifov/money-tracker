import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, type ThemeColors } from "../theme";

type Props = {
  title?: string;
  children?: ReactNode;
  theme?: ThemeColors;
};

/** A grey section header with its rows, as in Settings and the transaction form. */
export function GroupedSection({ title, children, theme = colors.light }: Props) {
  return (
    <View style={styles.section}>
      {title ? (
        <Text
          allowFontScaling
          accessibilityRole="header"
          style={[styles.header, { borderColor: theme.line, color: theme.ink }]}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 16,
  },
  header: {
    backgroundColor: "rgba(0,0,0,0.08)",
    fontSize: 13,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
});
