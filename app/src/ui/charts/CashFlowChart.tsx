import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Polyline } from "react-native-svg";

export interface CashFlowChartPoint {
  /** Period label, for example "October". */
  label: string;
  income: number;
  expense: number;
}

export interface CashFlowChartColors {
  income: string;
  expense: string;
  text: string;
  grid: string;
  pill: string;
}

type Props = {
  points: CashFlowChartPoint[];
  colors: CashFlowChartColors;
  /** Formats a minor amount for the pills. */
  formatAmount: (minor: number) => string;
  /** Spoken form of a minor amount for screen readers. */
  spokenAmount: (minor: number) => string;
  /** The height of the plot. With fill it is the minimum height. */
  height?: number;
  /** Grows the plot to the height of its parent. The default is on for the web. */
  fill?: boolean;
};

const PAD = 14;
const DEFAULT_WIDTH = 320;
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The smallest round number (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of 10) that is at least value. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return (NICE_STEPS.find((step) => step * power >= value) ?? 10) * power;
}

/** Income and expense as two lines. A tap on a point shows both values in two pills. */
export function CashFlowChart({
  points,
  colors,
  formatAmount,
  spokenAmount,
  height: minHeight = 180,
  fill = Platform.OS === "web",
}: Props) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [measuredHeight, setMeasuredHeight] = useState(minHeight);
  const [selected, setSelected] = useState<number | null>(null);
  const height = fill ? Math.max(minHeight, measuredHeight) : minHeight;

  const largest = Math.max(0, ...points.flatMap((p) => [p.income, p.expense]));
  const max = niceMax(largest);
  // Without income and expense the axis shows only 0. A small max (1 minor unit)
  // rounds the middle to the max, so the Set drops the repeated tick.
  const ticks = largest > 0 ? [...new Set([max, Math.round(max / 2), 0])] : [0];
  const step = points.length > 1 ? (width - 2 * PAD) / (points.length - 1) : 0;
  const x = (i: number) => (points.length > 1 ? PAD + i * step : width / 2);
  const y = (value: number) => height - PAD - (value / max) * (height - 2 * PAD);
  const line = (key: "income" | "expense") => points.map((p, i) => `${x(i)},${y(p[key])}`).join(" ");
  const hitWidth = points.length > 1 ? step : width;
  const chosen = selected === null ? null : points[selected];

  const onLayout = (event: LayoutChangeEvent) => {
    const layout = event.nativeEvent.layout;
    if (layout.width > 0) setWidth(layout.width);
    if (layout.height > 0) setMeasuredHeight(layout.height);
  };

  return (
    <View testID="cash-flow-chart" style={fill ? styles.fill : undefined}>
      <View style={[styles.plotRow, fill ? [styles.fill, { minHeight }] : { height }]}>
        {/* The y axis: the invisible widest label sets the width of the column. */}
        <View style={styles.yAxis}>
          <Text allowFontScaling style={[styles.yText, styles.ySizer]}>
            {formatAmount(max)}
          </Text>
          {ticks.map((tick) => (
            <Text
              key={tick}
              testID="cash-flow-y-label"
              allowFontScaling
              style={[styles.yText, styles.yLabel, { top: y(tick) - 7, color: colors.text }]}
            >
              {formatAmount(tick)}
            </Text>
          ))}
        </View>
        <View onLayout={onLayout} style={styles.plot}>
          <Svg width={width} height={height}>
            {ticks.slice(0, -1).map((tick) => (
              <Line
                key={tick}
                x1={PAD}
                y1={y(tick)}
                x2={width - PAD}
                y2={y(tick)}
                stroke={colors.grid}
                strokeWidth={1}
                strokeDasharray="3 4"
              />
            ))}
            <Line x1={PAD} y1={height - PAD} x2={width - PAD} y2={height - PAD} stroke={colors.grid} strokeWidth={1} />
            {selected !== null && (
              <Line x1={x(selected)} y1={PAD} x2={x(selected)} y2={height - PAD} stroke={colors.grid} strokeWidth={1} />
            )}
            <Polyline testID="cash-flow-income" points={line("income")} fill="none" stroke={colors.income} strokeWidth={2.5} />
            <Polyline testID="cash-flow-expense" points={line("expense")} fill="none" stroke={colors.expense} strokeWidth={2.5} />
            {points.map((p, i) => (
              <Circle key={`i${i}`} cx={x(i)} cy={y(p.income)} r={selected === i ? 5 : 3.5} fill={colors.income} />
            ))}
            {points.map((p, i) => (
              <Circle key={`e${i}`} cx={x(i)} cy={y(p.expense)} r={selected === i ? 5 : 3.5} fill={colors.expense} />
            ))}
          </Svg>
          {points.map((p, i) => (
            <Pressable
              key={i}
              testID={`cash-flow-point-${i}`}
              accessibilityRole="button"
              accessibilityLabel={`${p.label}: income ${spokenAmount(p.income)}, expense ${spokenAmount(p.expense)}`}
              accessibilityState={{ selected: selected === i }} aria-selected={selected === i}
              onPress={() => setSelected(i)}
              style={[styles.hit, { left: x(i) - hitWidth / 2, width: hitWidth }]}
            />
          ))}
        </View>
      </View>

      {points.length > 0 && (
        <View style={styles.axis}>
          <Text allowFontScaling style={[styles.axisText, { color: colors.text }]}>
            {points[0].label}
          </Text>
          <Text allowFontScaling style={[styles.axisText, { color: colors.text }]}>
            {points[points.length - 1].label}
          </Text>
        </View>
      )}

      {chosen && (
        <View testID="cash-flow-pills" style={styles.pills}>
          <Text allowFontScaling style={[styles.pillsLabel, { color: colors.text }]}>
            {chosen.label}
          </Text>
          <View style={styles.pillRow}>
            <Text allowFontScaling style={[styles.pill, { backgroundColor: colors.pill, borderColor: colors.income, color: colors.income }]}>
              {`Income ${formatAmount(chosen.income)}`}
            </Text>
            <Text allowFontScaling style={[styles.pill, { backgroundColor: colors.pill, borderColor: colors.expense, color: colors.expense }]}>
              {`Expense ${formatAmount(chosen.expense)}`}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  plotRow: {
    flexDirection: "row",
  },
  yAxis: {
    paddingRight: 2,
  },
  yText: {
    fontSize: 11,
    lineHeight: 14,
    textAlign: "right",
  },
  ySizer: {
    opacity: 0,
    height: 0,
  },
  yLabel: {
    position: "absolute",
    right: 2,
  },
  plot: {
    flex: 1,
  },
  hit: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
  axis: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginTop: 4,
  },
  axisText: {
    fontSize: 12,
  },
  pills: {
    alignItems: "center",
    marginTop: 12,
    gap: 6,
  },
  pillsLabel: {
    fontSize: 13,
  },
  pillRow: {
    flexDirection: "row",
    gap: 10,
  },
  pill: {
    borderWidth: 1.5,
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 12,
    fontSize: 14,
    overflow: "hidden",
  },
});
