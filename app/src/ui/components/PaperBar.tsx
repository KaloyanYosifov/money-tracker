import type { ReactNode } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { Texture } from "../Texture";
import { colors, paperTint, type ThemeColors } from "../theme";

type Props = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  theme?: ThemeColors;
};

/** The paper strip below the header, for example "All Accounts" or the Transfer button. */
export function PaperBar({ children, style, theme = colors.light }: Props) {
  return (
    <Texture kind="paper" tint={paperTint(theme)} style={[styles.bar, { borderBottomColor: theme.line }, style]}>
      {children}
    </Texture>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    justifyContent: "center",
    padding: 10,
    borderBottomWidth: 1,
  },
});
