import { router, Stack } from "expo-router";
import { act, renderRouter, screen } from "expo-router/testing-library";
import { Text } from "react-native";

import type { Shortcuts } from "../../src/hooks/useShortcuts";
import MainLayout from "./_layout";

// The last handlers that the layout passed to useShortcuts.
let mockShortcuts: Shortcuts = {};
jest.mock("../../src/hooks/useShortcuts", () => ({
  useShortcuts: (handlers: Shortcuts) => {
    mockShortcuts = handlers;
  },
}));

jest.mock("@powersync/react", () => ({
  ...jest.requireActual("@powersync/react"),
  usePowerSync: () => ({}),
  useQuery: () => ({ data: [], isLoading: false }),
}));

jest.mock("../../src/data/session", () => ({
  useSessionActions: () => ({ logout: jest.fn(async () => true), resetLocalData: jest.fn(async () => true) }),
}));

function renderApp(initialUrl: string) {
  return renderRouter(
    {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      "(main)/_layout": MainLayout,
      "(main)/spending": () => <Text>Spending page</Text>,
      "(main)/transactions": () => <Text>Transactions page</Text>,
      "(main)/categories": () => <Text>Categories page</Text>,
      "(main)/accounts": () => <Text>Accounts page</Text>,
      "(main)/reports": () => <Text>Reports page</Text>,
      settings: () => <Text>Settings page</Text>,
    },
    { initialUrl },
  );
}

describe("keyboard shortcuts of the pages", () => {
  it("work on a page, but not while a screen above the pages has focus", async () => {
    await renderApp("/spending");
    expect(await screen.findByText("Spending page")).toBeOnTheScreen();
    expect(mockShortcuts.page).toBeDefined();
    expect(mockShortcuts.newTransaction).toBeDefined();

    await act(async () => router.push("/settings"));
    expect(await screen.findByText("Settings page")).toBeOnTheScreen();
    expect(mockShortcuts.page).toBeUndefined();
    expect(mockShortcuts.newTransaction).toBeUndefined();

    await act(async () => router.back());
    expect(mockShortcuts.page).toBeDefined();
  });
});
