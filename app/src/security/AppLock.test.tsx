import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import { AppState, Text } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../test/sqlite";
import { AppLock, useAppLockAvailable } from "./AppLock";

let mockDb: TestDatabase;

jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) => ({
    data: mockDb.prepare(sql).all(parameters),
    isLoading: false,
  }),
}));

jest.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  authenticateAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
}));

const authenticate = LocalAuthentication.authenticateAsync as jest.Mock;
const enrolledLevel = LocalAuthentication.getEnrolledLevelAsync as jest.Mock;

let appStateListener: ((state: string) => void) | undefined;
let clock: number;

beforeEach(() => {
  mockDb = createTestDatabase();
  clock = 1_000_000;
  appStateListener = undefined;
  authenticate.mockReset().mockResolvedValue({ success: true });
  enrolledLevel.mockReset().mockResolvedValue(1);
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListener = listener as (state: string) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function setPrefs(prefs: Record<string, string>) {
  loadFixture(mockDb, {
    device_prefs: Object.entries(prefs).map(([key, value]) => ({ id: key, key, value })),
  });
}

async function renderLock(platform: "ios" | "web" = "ios") {
  return render(
    <AppLock platform={platform} now={() => clock}>
      <Text>Secret balance</Text>
    </AppLock>,
  );
}

async function changeAppState(state: string) {
  await act(async () => appStateListener?.(state));
}

const cover = () => screen.queryByTestId("privacy-cover");

describe("AppLock", () => {
  it("does nothing when App Lock is off", async () => {
    await renderLock();

    expect(screen.getByText("Secret balance")).toBeTruthy();
    expect(cover()).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();

    await changeAppState("background");
    expect(cover()).toBeNull();
  });

  it("starts locked and unlocks after a successful authentication", async () => {
    setPrefs({ appLock: "on" });
    let resolve: (result: { success: boolean }) => void = () => {};
    authenticate.mockReturnValue(new Promise((r) => (resolve = r)));

    await renderLock();

    expect(cover()).toBeTruthy();
    expect(authenticate).toHaveBeenCalledWith({
      promptMessage: "Unlock Money Tracker",
      disableDeviceFallback: false,
    });

    await act(async () => resolve({ success: true }));
    expect(cover()).toBeNull();
  });

  it("shows an Unlock button after a failed authentication", async () => {
    setPrefs({ appLock: "on" });
    authenticate.mockResolvedValueOnce({ success: false, error: "user_cancel" });

    await renderLock();

    const unlock = await screen.findByRole("button", { name: "Unlock" });
    expect(cover()).toBeTruthy();

    await fireEvent.press(unlock);
    await waitFor(() => expect(cover()).toBeNull());
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("covers the app at once in the background", async () => {
    setPrefs({ appLock: "on" });
    await renderLock();
    await waitFor(() => expect(cover()).toBeNull());

    await changeAppState("background");

    expect(cover()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unlock" })).toBeNull();
  });

  it("does not lock again when the time away is less than Lock After", async () => {
    setPrefs({ appLock: "on", lockAfterSeconds: "60" });
    await renderLock();
    await waitFor(() => expect(cover()).toBeNull());
    authenticate.mockClear();

    await changeAppState("background");
    clock += 59_000;
    await changeAppState("active");

    expect(cover()).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("locks again when the time away is at least Lock After", async () => {
    setPrefs({ appLock: "on", lockAfterSeconds: "300" });
    await renderLock();
    await waitFor(() => expect(cover()).toBeNull());
    authenticate.mockClear().mockResolvedValueOnce({ success: false, error: "user_cancel" });

    await changeAppState("background");
    clock += 300_000;
    await changeAppState("active");

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Unlock" })).toBeTruthy();
  });

  it("locks again at once with Lock After Immediately", async () => {
    setPrefs({ appLock: "on" });
    await renderLock();
    await waitFor(() => expect(cover()).toBeNull());
    authenticate.mockClear();

    await changeAppState("background");
    await changeAppState("active");

    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("does not lock again after the Face ID prompt makes the app inactive", async () => {
    setPrefs({ appLock: "on" });
    await renderLock();
    await waitFor(() => expect(cover()).toBeNull());
    authenticate.mockClear();

    await changeAppState("inactive");
    expect(cover()).toBeTruthy();
    await changeAppState("active");

    expect(cover()).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("only renders its children on the web", async () => {
    setPrefs({ appLock: "on" });
    await renderLock("web");

    expect(screen.getByText("Secret balance")).toBeTruthy();
    expect(cover()).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("useAppLockAvailable", () => {
  it("is true when the device has a passcode or biometrics", async () => {
    enrolledLevel.mockResolvedValue(1);
    const { result } = await renderHook(() => useAppLockAvailable());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is false when the device has no passcode and no biometrics", async () => {
    enrolledLevel.mockResolvedValue(0);
    const { result } = await renderHook(() => useAppLockAvailable());
    await waitFor(() => expect(result.current).toBe(false));
  });
});
