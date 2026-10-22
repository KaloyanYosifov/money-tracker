import { render, screen } from "@testing-library/react-native";

import { formatAmount } from "../../domain/money";
import { CashFlowChart } from "./CashFlowChart";
import { PieChart, type PieSlice } from "./PieChart";

function slice(id: string, value: number): PieSlice {
  return { id, label: id, value, color: "#8a5a44" };
}

function labels(): string[] {
  return screen.getAllByTestId("pie-percent", { includeHiddenElements: true }).map((label) => label.props.children);
}

describe("PieChart", () => {
  it("draws a full circle for a slice of 99.95 % or more", async () => {
    await render(<PieChart slices={[slice("big", 99970), slice("tiny", 30)]} labelColor="#ffffff" />);

    const big = screen.getByTestId("pie-slice-big");
    expect(big.props.r).toBe(110);
    expect(big.props.d).toBeUndefined();
    expect(labels()).toEqual(["100%"]);
  });

  it("draws a path for a large slice below 99.95 %", async () => {
    await render(<PieChart slices={[slice("big", 9990), slice("small", 10)]} labelColor="#ffffff" />);

    expect(screen.getByTestId("pie-slice-big").props.d).toEqual(expect.any(String));
  });

  it("hides the label of a smaller slice when it would overlap a label", async () => {
    await render(<PieChart slices={[slice("a", 6), slice("b", 6), slice("rest", 88)]} labelColor="#ffffff" />);

    expect(labels()).toEqual(["6%", "88%"]);
  });
});

describe("CashFlowChart", () => {
  const colors = { income: "#3b9d3b", expense: "#c62f2f", text: "#4b3022", grid: "#e2d9c8", pill: "#f6f2ea" };

  it("labels the y axis with 0, the middle and a round maximum", async () => {
    await render(
      <CashFlowChart
        points={[
          { label: "September", income: 280000, expense: 50000 },
          { label: "October", income: 250000, expense: 100000 },
        ]}
        colors={colors}
        formatAmount={(minor) => formatAmount(minor, "EUR", "en-GB")}
        spokenAmount={String}
      />,
    );

    const ticks = screen.getAllByTestId("cash-flow-y-label").map((label) => label.props.children);
    expect(ticks).toEqual(["€3,000.00", "€1,500.00", "€0.00"]);
  });

  it("shows only 0 on the y axis without income and expense", async () => {
    await render(
      <CashFlowChart
        points={[{ label: "October", income: 0, expense: 0 }]}
        colors={colors}
        formatAmount={(minor) => formatAmount(minor, "EUR", "en-GB")}
        spokenAmount={String}
      />,
    );

    expect(screen.getAllByTestId("cash-flow-y-label").map((label) => label.props.children)).toEqual(["€0.00"]);
  });

  it("shows each tick once when the middle rounds to the maximum", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    await render(
      <CashFlowChart
        points={[{ label: "October", income: 1, expense: 0 }]}
        colors={colors}
        formatAmount={(minor) => formatAmount(minor, "EUR", "en-GB")}
        spokenAmount={String}
      />,
    );

    expect(screen.getAllByTestId("cash-flow-y-label").map((label) => label.props.children)).toEqual(["€0.01", "€0.00"]);
    expect(error.mock.calls.flat().map(String).join(" ")).not.toContain("same key");
    error.mockRestore();
  });
});
