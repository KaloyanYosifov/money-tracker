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

// The user_settings rows that the layout reads.
let mockSettings: Record<string, unknown>[] = [];
jest.mock("@powersync/react", () => ({
  ...jest.requireActual("@powersync/react"),
  usePowerSync: () => ({}),
  useQuery: () => ({ data: mockSettings, isLoading: false }),
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
      "(main)/insights": () => <Text>AI Insights page</Text>,
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

describe("the AI Insights tab", () => {
  afterEach(() => {
    mockSettings = [];
  });

  it("is hidden while the AI Insights switch is off", async () => {
    mockSettings = [{ id: "s1", insights_enabled: 0 }];
    await renderApp("/spending");
    expect(await screen.findByText("Spending page")).toBeOnTheScreen();
    expect(screen.getByTestId("tab-accounts")).toBeOnTheScreen();
    expect(screen.queryByTestId("tab-insights")).toBeNull();
  });

  it("shows after Accounts, as the fifth iPhone tab, while the switch is on", async () => {
    mockSettings = [{ id: "s1", insights_enabled: 1 }];
    await renderApp("/spending");
    expect(await screen.findByText("Spending page")).toBeOnTheScreen();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.props.testID);
    expect(tabs).toEqual(["tab-spending", "tab-transactions", "tab-categories", "tab-accounts", "tab-insights"]);
  });

  it("keeps keys 1 to 5 on the first five pages, so Reports stays on 5", async () => {
    mockSettings = [{ id: "s1", insights_enabled: 1 }];
    await renderApp("/spending");
    expect(await screen.findByText("Spending page")).toBeOnTheScreen();
    await act(async () => mockShortcuts.page?.(5));
    expect(await screen.findByText("Reports page")).toBeOnTheScreen();
  });
});
