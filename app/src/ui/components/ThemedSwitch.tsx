import { Platform, Switch, type SwitchProps } from "react-native";

import { colors, type ThemeColors } from "../theme";

const THUMB = "#ffffff";

/** A switch with the accent track and a white thumb, as in the mockups. */
export function ThemedSwitch({ theme = colors.light, ...props }: Omit<SwitchProps, "trackColor" | "thumbColor"> & { theme?: ThemeColors }) {
  // react-native-web paints the "on" thumb with activeThumbColor (teal by default), not thumbColor.
  const webThumb = Platform.OS === "web" ? ({ activeThumbColor: THUMB } as object) : {};
  return <Switch {...props} {...webThumb} thumbColor={THUMB} trackColor={{ true: theme.accent, false: theme.line }} />;
}
