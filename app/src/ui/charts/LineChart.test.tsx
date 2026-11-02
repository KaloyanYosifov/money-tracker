import { processColor } from "react-native";
import { render, screen } from "@testing-library/react-native";

import { LineChart } from "./LineChart";

/** The rendered Polyline is a path: "M x0 y0 x1 y1 ...". */
function coordinates(d: string): [number, number][] {
  const numbers = d.replace(/[A-Za-z,]/g, " ").trim().split(/\s+/).map(Number);
  const pairs: [number, number][] = [];
  for (let i = 0; i < numbers.length; i += 2) pairs.push([numbers[i], numbers[i + 1]]);
  return pairs;
}

describe("LineChart", () => {
  it("draws one line with a point for each value that fills the width and height", async () => {
    await render(
      <LineChart
        points={[
          { date: "2026-01-01", value: 10 },
          { date: "2026-02-01", value: 30 },
          { date: "2026-03-01", value: 20 },
        ]}
        color="#8ee08f"
        width={300}
        height={100}
        accessibilityLabel="Portfolio value, last year"
      />,
    );

    const lines = screen.getAllByTestId("line-chart-line", { includeHiddenElements: true });
    expect(lines).toHaveLength(1);
    expect(lines[0].props.stroke).toEqual(expect.objectContaining({ payload: processColor("#8ee08f") }));
    const xy = coordinates(lines[0].props.d);
    expect(xy).toHaveLength(3);
    expect(xy[0][0]).toBe(0);
    expect(xy[2][0]).toBe(300);
    expect(xy[1][1]).toBeLessThan(xy[2][1]);
    expect(xy[2][1]).toBeLessThan(xy[0][1]);
    const ys = xy.map(([, y]) => y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(80);
    expect(screen.getByLabelText("Portfolio value, last year")).toBeTruthy();
  });

  it("draws a flat line in the middle when all values are equal", async () => {
    await render(
      <LineChart
        points={[
          { date: "2026-01-01", value: 5 },
          { date: "2026-02-01", value: 5 },
        ]}
        color="#8ee08f"
        width={200}
        height={100}
        accessibilityLabel="Price"
      />,
    );

    const xy = coordinates(screen.getByTestId("line-chart-line", { includeHiddenElements: true }).props.d);
    expect(xy.map(([, y]) => y)).toEqual([50, 50]);
  });

  it.each([[[]], [[{ date: "2026-01-01", value: 1 }]]])("shows Not enough data with %j", async (points) => {
    await render(<LineChart points={points} color="#8ee08f" height={100} accessibilityLabel="Price" />);

    expect(screen.getByText("Not enough data")).toBeTruthy();
    expect(screen.queryAllByTestId("line-chart-line", { includeHiddenElements: true })).toHaveLength(0);
  });
});
