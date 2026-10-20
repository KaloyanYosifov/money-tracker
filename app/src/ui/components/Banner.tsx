import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, type ThemeColors } from "../theme";

type Props = {
  title: string;
  text: string;
  /** Without an action label the banner has no button. */
  actionLabel?: string;
  onAction?: () => void;
  /** The action button gets `${testID}-action`. */
  testID?: string;
  theme?: ThemeColors;
};

/** A message above the content with at most one action, for example "Log in again". */
export function Banner({ title, text, actionLabel, onAction, testID, theme = colors.light }: Props) {
  return (
    <View testID={testID} accessibilityRole="alert" style={[styles.banner, { backgroundColor: theme.carryOver, borderColor: theme.line }]}>
      <View style={styles.body}>
        <Text allowFontScaling style={[styles.title, { color: theme.ink }]}>
          {title}
        </Text>
        <Text allowFontScaling style={[styles.text, { color: theme.ink }]}>
          {text}
        </Text>
      </View>
      {actionLabel && onAction ? (
        <Pressable
          testID={testID ? `${testID}-action` : undefined}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={[styles.action, { borderColor: theme.accent }]}
        >
          <Text allowFontScaling style={[styles.actionLabel, { color: theme.accent }]}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  body: {
    flex: 1,
    marginRight: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
  },
  text: {
    fontSize: 13,
    marginTop: 2,
  },
  action: {
    borderWidth: 1.5,
    borderRadius: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  actionLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
});
