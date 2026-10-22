import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import SettingsRoute from "./settings";

const mockResetLocalData = jest.fn();
jest.mock("../src/data/session", () => ({
  useSessionActions: () => ({ logout: jest.fn(async () => true), resetLocalData: mockResetLocalData }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn(), push: jest.fn() }),
}));

jest.mock("../src/ui/nav/DeskScreen", () => ({
  DeskScreen: ({ children }: { children: unknown }) => children,
}));

// Only the Reset local data button of the Settings screen.
jest.mock("../src/ui/screens/Settings", () => ({
  Settings: ({ onResetLocalData }: { onResetLocalData: () => void }) => {
    const { Pressable: MockPressable, Text: MockText } = jest.requireActual<typeof import("react-native")>("react-native");
    return (
      <MockPressable accessibilityRole="button" accessibilityLabel="Reset local data" onPress={onResetLocalData}>
        <MockText>Reset local data</MockText>
      </MockPressable>
    );
  },
}));

it("shows an alert when Reset local data fails", async () => {
  mockResetLocalData.mockRejectedValueOnce(new Error("disconnect failed"));
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(<SettingsRoute />);

  await fireEvent.press(screen.getByRole("button", { name: "Reset local data" }));

  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith("Reset failed", "The local data was not reset. Try again."),
  );
  alert.mockRestore();
});
