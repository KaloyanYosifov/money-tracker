import type { ReactElement } from "react";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { colors } from "../theme";

export type TabIconName = "tag" | "notepad" | "cabinet" | "people" | "pie" | "sparkle" | "gear";

type Props = {
  name: TabIconName;
  /** The active tab uses the filled version. */
  filled?: boolean;
  size?: number;
  color?: string;
  /** Colour behind the icon. The filled version draws its inner lines with it. */
  background?: string;
};

type DrawProps = { color: string; background: string };

// Paths on a 48 by 48 grid, from the approved mockup.
const outline: Record<TabIconName, (p: DrawProps) => ReactElement> = {
  tag: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round">
      <Path d="M27 12 41 10 39 24 22 41 10 29Z" />
      <Circle cx={34.5} cy={16.5} r={2.2} />
      <Path d="M36 15c4-6 9-8 10-6" />
    </G>
  ),
  notepad: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={1.6}>
      <Rect x={11} y={9} width={26} height={32} rx={1.5} />
      <Path d="M15 6v6M18 6v6M21 6v6M24 6v6M27 6v6M30 6v6M33 6v6" />
      <Path d="M15 20h18M15 25h18M15 30h18M15 35h12" />
    </G>
  ),
  cabinet: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={1.6}>
      <Rect x={11} y={7} width={26} height={35} rx={1} />
      <Path d="M11 18.5h26M11 30h26M21 12h6M21 23.5h6M21 35h6M21 11v2.5M27 11v2.5M21 22.5v2.5M27 22.5v2.5M21 34v2.5M27 34v2.5" />
    </G>
  ),
  people: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round">
      <Circle cx={24} cy={18} r={5} />
      <Path d="M14 34c0-6 4-9 10-9s10 3 10 9Z" />
      <Circle cx={12} cy={20} r={4} />
      <Path d="M3 33c0-5 3-8 8-8 2 0 3.5.4 4.7 1.2" />
      <Circle cx={36} cy={20} r={4} />
      <Path d="M45 33c0-5-3-8-8-8-2 0-3.5.4-4.7 1.2" />
    </G>
  ),
  pie: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round">
      <Circle cx={24} cy={25} r={14} />
      <Path d="M24 11v14l12 7" />
    </G>
  ),
  sparkle: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round">
      <Path d="M24 7c1.4 8.6 4.4 11.6 13 13-8.6 1.4-11.6 4.4-13 13-1.4-8.6-4.4-11.6-13-13 8.6-1.4 11.6-4.4 13-13Z" />
      <Path d="M37 30c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5Z" />
    </G>
  ),
  gear: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={1.6}>
      <Circle cx={24} cy={24} r={6} />
      <Path d="M24 8v5M24 35v5M8 24h5M35 24h5M12.7 12.7l3.5 3.5M31.8 31.8l3.5 3.5M12.7 35.3l3.5-3.5M31.8 16.2l3.5-3.5" />
    </G>
  ),
};

const filled: Record<TabIconName, (p: DrawProps) => ReactElement> = {
  tag: ({ color, background }) => (
    <G>
      <Path d="M27 12 41 10 39 24 22 41 10 29Z" fill={color} />
      <Circle cx={34.5} cy={16.5} r={2.2} fill={background} />
      <Path d="M36 15c4-6 9-8 10-6" fill="none" stroke={color} strokeWidth={1.6} />
    </G>
  ),
  notepad: ({ color, background }) => (
    <G>
      <Rect x={11} y={9} width={26} height={32} rx={1.5} fill={color} />
      <Path d="M15 6v6M18 6v6M21 6v6M24 6v6M27 6v6M30 6v6M33 6v6" stroke={color} strokeWidth={1.6} />
      <Path d="M15 20h18M15 25h18M15 30h18M15 35h12" stroke={background} strokeWidth={1.6} />
    </G>
  ),
  cabinet: ({ color, background }) => (
    <G>
      <Rect x={11} y={7} width={26} height={35} rx={1} fill={color} />
      <Path d="M11 18.5h26M11 30h26M21 12h6M21 23.5h6M21 35h6" fill="none" stroke={background} strokeWidth={1.6} />
    </G>
  ),
  people: ({ color }) => (
    <G fill={color}>
      <Circle cx={24} cy={18} r={5.5} />
      <Path d="M13 35c0-6 4.5-10 11-10s11 4 11 10Z" />
      <Circle cx={11.5} cy={20} r={4.5} />
      <Path d="M2 34c0-5 3.5-8.5 9-8.5 2 0 3.6.5 4.8 1.3-2 2-3.3 4.7-3.6 7.2Z" />
      <Circle cx={36.5} cy={20} r={4.5} />
      <Path d="M46 34c0-5-3.5-8.5-9-8.5-2 0-3.6.5-4.8 1.3 2 2 3.3 4.7 3.6 7.2Z" />
    </G>
  ),
  pie: ({ color, background }) => (
    <G>
      <Circle cx={24} cy={25} r={14.8} fill={color} />
      <Path d="M24 11v14l12 7" fill="none" stroke={background} strokeWidth={1.6} strokeLinejoin="round" />
    </G>
  ),
  sparkle: ({ color }) => (
    <G fill={color}>
      <Path d="M24 7c1.4 8.6 4.4 11.6 13 13-8.6 1.4-11.6 4.4-13 13-1.4-8.6-4.4-11.6-13-13 8.6-1.4 11.6-4.4 13-13Z" />
      <Path d="M37 30c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5Z" />
    </G>
  ),
  gear: ({ color, background }) => (
    <G>
      <Path
        d="M24 8v5M24 35v5M8 24h5M35 24h5M12.7 12.7l3.5 3.5M31.8 31.8l3.5 3.5M12.7 35.3l3.5-3.5M31.8 16.2l3.5-3.5"
        stroke={color}
        strokeWidth={3.2}
      />
      <Circle cx={24} cy={24} r={11} fill={color} />
      <Circle cx={24} cy={24} r={4} fill={background} />
    </G>
  ),
};

export function TabIcon({
  name,
  filled: isFilled = false,
  size = 34,
  color = colors.light.ink,
  background = colors.light.paper,
}: Props) {
  const draw = isFilled ? filled[name] : outline[name];
  return (
    <Svg
      // A new key per variant mounts new shapes. iOS keeps a fill that a re-render removes, so outline icons stayed filled.
      key={isFilled ? "filled" : "outline"}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      testID={`tab-icon-${name}-${isFilled ? "filled" : "outline"}`}
    >
      {draw({ color, background })}
    </Svg>
  );
}
