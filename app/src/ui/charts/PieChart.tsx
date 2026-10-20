import { Platform, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from "react-native-svg";

export interface PieSlice {
  id: string;
  label: string;
  value: number;
  color: string;
}

type Props = {
  slices: PieSlice[];
  size?: number;
  /** Colour of the percentage labels. */
  labelColor: string;
  onSlicePress?: (id: string) => void;
};

/** Slices with a smaller share than this get no percentage label. */
const LABEL_MIN_SHARE = 0.05;

/** Mixes a #rrggbb colour with black (amount < 0) or white (amount > 0). */
function shade(hex: string, amount: number): string {
  const target = amount < 0 ? 0 : 255;
  const channels = [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16);
    const mixed = Math.round(value + (target - value) * Math.abs(amount));
    return mixed.toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function point(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = point(cx, cy, r, from);
  const [x2, y2] = point(cx, cy, r, to);
  const large = to - from > Math.PI ? 1 : 0;
  return `M${cx} ${cy}L${x1} ${y1}A${r} ${r} 0 ${large} 1 ${x2} ${y2}Z`;
}

/** Share of the total as a whole percent. */
export function percent(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

/** A pie with a radial gradient on each slice. Slices start at 12 o'clock and go clockwise. */
export function PieChart({ slices, size = 220, labelColor, onSlicePress }: Props) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const r = size / 2;
  const arcs: { slice: PieSlice; from: number; to: number }[] = [];
  for (const slice of slices) {
    const from = arcs.length > 0 ? arcs[arcs.length - 1].to : 0;
    const to = from + (total > 0 ? (slice.value / total) * 2 * Math.PI : 0);
    arcs.push({ slice, from, to });
  }

  return (
    <View testID="pie-chart" style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Defs>
          {slices.map((slice) => (
            <RadialGradient
              key={slice.id}
              id={`pie-shade-${slice.id}`}
              cx={r}
              cy={r}
              r={r}
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor={shade(slice.color, 0.3)} />
              <Stop offset="0.65" stopColor={slice.color} />
              <Stop offset="1" stopColor={shade(slice.color, -0.3)} />
            </RadialGradient>
          ))}
        </Defs>
        {arcs.map(({ slice, from, to }) => {
          const common = {
            testID: `pie-slice-${slice.id}`,
            fill: `url(#pie-shade-${slice.id})`,
            stroke: "#ffffff",
            strokeWidth: slices.length > 1 ? 1 : 0,
            // On the web, react-native-svg turns onPress into responder props on the DOM node, and React warns.
            ...(Platform.OS === "web"
              ? ({ onClick: onSlicePress ? () => onSlicePress(slice.id) : undefined } as object)
              : { onPress: onSlicePress ? () => onSlicePress(slice.id) : undefined }),
          };
          // An arc from 0 to 2π has the same start and end point and draws nothing.
          return to - from >= 2 * Math.PI - 1e-9 ? (
            <Circle key={slice.id} cx={r} cy={r} r={r} {...common} />
          ) : (
            <Path key={slice.id} d={arcPath(r, r, r, from, to)} {...common} />
          );
        })}
      </Svg>
      {arcs.map(({ slice, from, to }) => {
        if (total <= 0 || slice.value / total <= LABEL_MIN_SHARE) return null;
        const [x, y] = point(r, r, r * 0.65, (from + to) / 2);
        return (
          <Text
            key={slice.id}
            testID="pie-percent"
            pointerEvents="none"
            importantForAccessibility="no"
            accessibilityElementsHidden
            style={[styles.label, { left: x - 24, top: y - 9, color: labelColor }]}
          >
            {`${percent(slice.value, total)}%`}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    width: 48,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "700",
    textShadowColor: "rgba(0, 0, 0, 0.45)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
