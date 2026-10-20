import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, type ThemeColors } from "../theme";

type Props = {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
  theme?: ThemeColors;
};

/** A row with an icon and a title, as in the Categories and Accounts lists. */
export function ListRow({ title, icon, right, onPress, onLongPress, testID, theme = colors.light }: Props) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={title}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress}
      testID={testID}
      style={[styles.row, { backgroundColor: theme.row, borderBottomColor: theme.line }]}
    >
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text allowFontScaling style={[styles.title, { color: theme.ink }]}>
        {title}
      </Text>
      {right}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 50,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  icon: {
    marginRight: 14,
  },
  title: {
    flex: 1,
    fontSize: 20,
  },
});
