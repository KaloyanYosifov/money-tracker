import { fireEvent, render, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Pressable, Text } from "react-native";

import { TabletSplit } from "./TabletSplit";

// The chalkboard has one category line. The list shows its category filter and can clear it, like "All categories".
jest.mock("./Chalkboard", () => ({
  Chalkboard: ({ onCategoryPress }: { onCategoryPress: (categoryId: string, accountId: string | null) => void }) => {
    const { Pressable: Button, Text: Label } = jest.requireActual("react-native");
    return (
      <Button accessibilityRole="button" accessibilityLabel="Groceries" onPress={() => onCategoryPress("groceries", null)}>
        <Label>Groceries</Label>
      </Button>
    );
  },
}));

jest.mock("./TransactionList", () => ({
  TransactionList: ({ initialCategoryId }: { initialCategoryId: string | null }) => mockList(initialCategoryId),
}));

jest.mock("./manage", () => ({
  useScreenSettings: () => ({ theme: jest.requireActual("../theme").colors.light }),
}));

function MockList({ initial }: { initial: string | null }) {
  const [categoryId, setCategoryId] = useState(initial);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="All categories" onPress={() => setCategoryId(null)}>
      <Text testID="list-category">{categoryId ?? "all"}</Text>
    </Pressable>
  );
}

function mockList(initial: string | null) {
  return <MockList initial={initial} />;
}

const period = { start: "2026-10-01", end: "2026-10-31" };

describe("TabletSplit", () => {
  it("filters the list again when the same category is pressed after the filter was cleared", async () => {
    await render(<TabletSplit period={period} onOpen={jest.fn()} onAdd={jest.fn()} onShift={jest.fn()} />);

    await fireEvent.press(screen.getByRole("button", { name: "Groceries" }));
    expect(screen.getByTestId("list-category").props.children).toBe("groceries");

    await fireEvent.press(screen.getByRole("button", { name: "All categories" }));
    expect(screen.getByTestId("list-category").props.children).toBe("all");

    await fireEvent.press(screen.getByRole("button", { name: "Groceries" }));
    expect(screen.getByTestId("list-category").props.children).toBe("groceries");
  });
});
