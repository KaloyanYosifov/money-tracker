import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useLayoutMode } from "../../hooks/useLayoutMode";
import { useScreenSettings } from "../screens/manage";
import { CARD_WIDTH } from "./Sidebar";

/**
 * A screen outside the tabs (Settings, the forms). In the browser layout it shows
 * as a content card above the dimmed page, so the sidebar and the page stay in view.
 */
export function DeskScreen({ children }: { children: ReactNode }) {
  const mode = useLayoutMode();
  const { theme } = useScreenSettings();
  if (mode !== "sidebar") return <>{children}</>;
  return (
    <View style={styles.backdrop}>
      <View style={[styles.card, { backgroundColor: theme.paper }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
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
