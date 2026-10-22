import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";

import { colors } from "../theme";

/** Two opposite arrows (⇄) for a transfer row, on the 32 by 32 grid of the category icons. */
export function TransferIcon({ size = 30, color = colors.light.ink }: { size?: number; color?: string }) {
  const line = { fill: "none", stroke: color, strokeWidth: 2.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      // react-native-svg passes `accessible` to the DOM on the web, and React warns about it.
      {...(Platform.OS === "web" ? {} : { accessible: true })}
      accessibilityRole="image"
      accessibilityLabel="Transfer"
      testID="transfer-icon"
    >
      <Path {...line} d="M5 11h21M20 5l6 6-6 6" />
      <Path {...line} d="M27 21H6M12 15l-6 6 6 6" />
    </Svg>
  );
}
