import { Pressable, StyleSheet, Text } from "react-native";

import { colors, type ThemeColors } from "../theme";

type Props = {
  visible: boolean;
  onUndo: () => void;
  theme?: ThemeColors;
  /** Distance from the bottom of the screen, for example above a toolbar. */
  bottom?: number;
};

/** The toast after a delete. Connect onUndo to useUndo().undo. */
export function UndoToast({ visible, onUndo, theme = colors.light, bottom = 24 }: Props) {
  if (!visible) return null;
  return (
    <Pressable
      testID="undo-toast"
      accessibilityRole="button"
      accessibilityLabel="Deleted. Undo"
      accessibilityLiveRegion="polite"
      onPress={onUndo}
      // Ink on paper, inverted, like the tooltips. In the dark theme the toast is light on the dark list.
      style={[styles.toast, { bottom, backgroundColor: theme.ink }]}
    >
      <Text allowFontScaling style={[styles.text, { color: theme.paper }]}>
        Deleted · Undo
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 22,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  text: {
    fontSize: 13,
  },
});
