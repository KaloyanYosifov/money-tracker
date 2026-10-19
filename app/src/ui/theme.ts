import type { ColorSchemeName } from "react-native";

import type { UserSettings } from "../generated/schema";

export type ThemeName = "light" | "dark";

export type ThemeColors = {
  statusBar: string;
  ink: string;
  accent: string;
  paper: string;
  row: string;
  line: string;
  carryOver: string;
  chalkBackground: string;
  chalkGreen: string;
  chalkRed: string;
  chalkBlue: string;
  listGreen: string;
  listRed: string;
  transferButton: string;
  settingsBlue: string;
};

export const colors: Record<ThemeName, ThemeColors> = {
  light: {
    statusBar: "#5b3522",
    ink: "#4b3022",
    accent: "#8a5a44",
    paper: "#f1ece2",
    row: "#f6f2ea",
    line: "#e2d9c8",
    carryOver: "#f6dfc6",
    chalkBackground: "#2a2a2a",
    chalkGreen: "#8ee08f",
    chalkRed: "#ff8a86",
    chalkBlue: "#83defa",
    listGreen: "#3b9d3b",
    listRed: "#c62f2f",
    transferButton: "#36c94a",
    settingsBlue: "#1d4f9a",
  },
  dark: {
    statusBar: "#2b1a10",
    ink: "#e8dccb",
    accent: "#c08a6e",
    paper: "#23201c",
    row: "#2c2824",
    line: "#3d3730",
    carryOver: "#4a3626",
    chalkBackground: "#1c1c1c",
    chalkGreen: "#7fd180",
    chalkRed: "#f07d79",
    chalkBlue: "#76cbe6",
    listGreen: "#5cc25c",
    listRed: "#ef6461",
    transferButton: "#2ea83f",
    settingsBlue: "#7fa8e8",
  },
};

/** Font family name that the root layout registers with expo-font. */
export const MONO_FONT = "DroidSansMono";

export function resolveTheme(setting: UserSettings["theme"], system: ColorSchemeName): ThemeName {
  if (setting === "system") {
    return system === "dark" ? "dark" : "light";
  }
  return setting;
}

/** Font family for the chalkboard summary. undefined selects the system font. */
export function summaryFontFamily(summaryFont: UserSettings["summary_font"]): string | undefined {
  return summaryFont === "mono" ? MONO_FONT : undefined;
}
