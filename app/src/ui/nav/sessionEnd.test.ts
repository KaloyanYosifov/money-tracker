import { act, renderHook } from "@testing-library/react-native";

import type { AuthStatus } from "../../auth/AuthProvider";
import { closeOverlays, useCloseWithOverlays } from "../overlays";
import { CLOSE_DELAY_MS, closeForSessionEnd, sessionEnded, useSessionEndCleanup } from "./sessionEnd";

const mockRouter = { canDismiss: jest.fn(() => true), dismissAll: jest.fn() };
jest.mock("expo-router", () => ({ useRouter: () => mockRouter }));

beforeEach(() => {
  jest.useFakeTimers();
  mockRouter.canDismiss.mockReturnValue(true);
  mockRouter.dismissAll.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("sessionEnded", () => {
  it("is true only when a signed-in session ends", () => {
    expect(sessionEnded("signedIn", "reauthRequired")).toBe(true);
    expect(sessionEnded("signedIn", "signedOut")).toBe(true);
    expect(sessionEnded("loading", "reauthRequired")).toBe(false);
    expect(sessionEnded("reauthRequired", "signedOut")).toBe(false);
    expect(sessionEnded("reauthRequired", "signedIn")).toBe(false);
    expect(sessionEnded("signedIn", "signedIn")).toBe(false);
  });
});

describe("closeForSessionEnd", () => {
  it("dismisses the forms and pages before Log in again", () => {
    expect(closeForSessionEnd("reauthRequired", mockRouter)).toBe(true);
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
  });

  it("leaves the stack to Stack.Protected on a sign-out", () => {
    expect(closeForSessionEnd("signedOut", mockRouter)).toBe(false);
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
  });

  it("closes an open calendar even when only the tabs show", async () => {
    mockRouter.canDismiss.mockReturnValue(false);
    const onClose = jest.fn();
    await renderHook(() => useCloseWithOverlays(true, onClose));

    expect(closeForSessionEnd("reauthRequired", mockRouter)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
  });

  it("has nothing to close on the tabs", () => {
    mockRouter.canDismiss.mockReturnValue(false);
    expect(closeOverlays()).toBe(0);
    expect(closeForSessionEnd("reauthRequired", mockRouter)).toBe(false);
  });
});

describe("useSessionEndCleanup", () => {
  async function renderCleanup(status: AuthStatus) {
    return renderHook(({ status: current }: { status: AuthStatus }) => useSessionEndCleanup(current), {
      initialProps: { status },
    });
  }

  it("holds the login until the open form has closed", async () => {
    const onClose = jest.fn();
    await renderHook(() => useCloseWithOverlays(true, onClose));
    const { result, rerender } = await renderCleanup("signedIn");
    expect(result.current).toBe(true);

    await rerender({ status: "reauthRequired" });
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);

    await act(async () => jest.advanceTimersByTime(CLOSE_DELAY_MS));
    expect(result.current).toBe(true);
  });

  it("shows the login at once when nothing is open", async () => {
    mockRouter.canDismiss.mockReturnValue(false);
    const { result, rerender } = await renderCleanup("signedIn");
    await rerender({ status: "reauthRequired" });
    expect(result.current).toBe(true);
  });

  it("does not dismiss at an app start that needs a login", async () => {
    const { result, rerender } = await renderCleanup("loading");
    await rerender({ status: "reauthRequired" });
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
    expect(result.current).toBe(true);
  });

  it("dismisses again when a later session ends", async () => {
    const { rerender } = await renderCleanup("signedIn");
    await rerender({ status: "reauthRequired" });
    await act(async () => jest.advanceTimersByTime(CLOSE_DELAY_MS));
    await rerender({ status: "signedIn" });
    await rerender({ status: "reauthRequired" });
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(2);
  });
});
