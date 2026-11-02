import { useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Polyline } from "react-native-svg";

export interface LineChartPoint {
  date: string;
  /** A number only for the drawing. Amounts stay decimal strings elsewhere. */
  value: number;
}

type Props = {
  points: LineChartPoint[];
  color: string;
  height: number;
  accessibilityLabel: string;
  /** A fixed width. Without it the chart fills the width of its parent. */
  width?: number;
};

const STROKE = 2;
const DEFAULT_WIDTH = 320;

/** One line without axes, as in the chalkboard and the asset detail of the prototype. */
export function LineChart({ points, color, height, accessibilityLabel, width: fixedWidth }: Props) {
  const [measured, setMeasured] = useState(DEFAULT_WIDTH);
  const width = fixedWidth ?? measured;

  const onLayout = (event: LayoutChangeEvent) => {
    if (fixedWidth === undefined && event.nativeEvent.layout.width > 0) setMeasured(event.nativeEvent.layout.width);
  };

  if (points.length < 2) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={[styles.empty, { height, width: fixedWidth }]}
      >
        <Text allowFontScaling style={[styles.emptyText, { color }]}>
          Not enough data
        </Text>
      </View>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const top = STROKE / 2;
  const plot = height - STROKE;
  const x = (i: number) => (i / (points.length - 1)) * width;
  // The highest value is at the top. A flat series sits in the middle.
  const y = (value: number) => (span === 0 ? height / 2 : top + ((max - value) / span) * plot);
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      onLayout={onLayout}
      style={{ height, width: fixedWidth }}
    >
      <Svg width={width} height={height}>
        <Polyline
          testID="line-chart-line"
          points={line}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 13,
    opacity: 0.8,
  },
});
