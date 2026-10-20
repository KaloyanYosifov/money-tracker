import { Pressable, StyleSheet, Text } from "react-native";

type Props = {
  visible: boolean;
  onUndo: () => void;
};

/** The toast after a delete. Connect onUndo to useUndo().undo. */
export function UndoToast({ visible, onUndo }: Props) {
  if (!visible) return null;
  return (
    <Pressable
      testID="undo-toast"
      accessibilityRole="button"
      accessibilityLabel="Deleted. Undo"
      accessibilityLiveRegion="polite"
      onPress={onUndo}
      style={styles.toast}
    >
      <Text allowFontScaling style={styles.text}>
        Deleted · Undo
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    alignSelf: "center",
    bottom: 24,
    backgroundColor: "#f1ecf3",
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
    color: "#222",
  },
});
