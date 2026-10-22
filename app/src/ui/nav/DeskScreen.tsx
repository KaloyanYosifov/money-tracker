import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLayoutMode } from "../../hooks/useLayoutMode";
import { useScreenSettings } from "../screens/manage";
import { BottomInsetContext } from "./bottomInset";
import { CARD_WIDTH } from "./Sidebar";

/**
 * A screen outside the tabs (Settings, the forms). In the browser layout it shows
 * as a content card above the dimmed page, so the sidebar and the page stay in view.
 * Both layouts render the same views and change only the styles, so the screen keeps
 * its state (for example typed input) when the window crosses the sidebar width.
 */
export function DeskScreen({ children }: { children: ReactNode }) {
  const mode = useLayoutMode();
  const { theme } = useScreenSettings();
  const insets = useSafeAreaInsets();
  const desk = mode === "sidebar";
  // Phone: the content keeps clear of the notch (landscape) and the rounded corners.
  // The scroll content takes the bottom inset itself (see useBottomInset), so it scrolls below the home indicator.
  const phone = [styles.fill, { paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: theme.paper }];
  return (
    <BottomInsetContext.Provider value={desk ? 0 : insets.bottom}>
      <View style={desk ? styles.backdrop : phone}>
        <View style={desk ? [styles.card, { backgroundColor: theme.paper }] : styles.fill}>{children}</View>
      </View>
    </BottomInsetContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 22,
    backgroundColor: "rgba(43, 26, 16, 0.35)",
  },
  card: {
    width: CARD_WIDTH,
    flex: 1,
    borderRadius: 8,
    overflow: "hidden",
    shadowColor: "#3c2314",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
  },
});
