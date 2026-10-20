import { Platform, useWindowDimensions } from "react-native";

export type LayoutMode = "tabs" | "sidebar" | "phoneLandscape" | "tabletSplit";

/** Below this window width the browser uses the phone layout. */
export const SIDEBAR_MIN_WIDTH = 900;

export interface LayoutInput {
  platform: typeof Platform.OS;
  width: number;
  height: number;
  isTablet: boolean;
}

export function layoutModeFor({ platform, width, height, isTablet }: LayoutInput): LayoutMode {
  if (platform === "web") {
    return width >= SIDEBAR_MIN_WIDTH ? "sidebar" : "tabs";
  }
  if (width > height) {
    return isTablet ? "tabletSplit" : "phoneLandscape";
  }
  return "tabs";
}

export function useLayoutMode(): LayoutMode {
  const { width, height } = useWindowDimensions();
  const isTablet = Platform.OS === "ios" && Platform.isPad;
  return layoutModeFor({ platform: Platform.OS, width, height, isTablet });
}
