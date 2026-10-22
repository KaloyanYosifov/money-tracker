import { renderHook } from "@testing-library/react-native";

import { closeOverlays, useCloseWithOverlays } from "./overlays";

describe("useCloseWithOverlays", () => {
  it("closes the visible overlays and counts them", async () => {
    const calendar = jest.fn();
    const picker = jest.fn();
    await renderHook(() => useCloseWithOverlays(true, calendar));
    await renderHook(() => useCloseWithOverlays(true, picker));

    expect(closeOverlays()).toBe(2);
    expect(calendar).toHaveBeenCalledTimes(1);
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it("does not call a hidden or unmounted overlay", async () => {
    const hidden = jest.fn();
    const gone = jest.fn();
    await renderHook(() => useCloseWithOverlays(false, hidden));
    const mounted = await renderHook(() => useCloseWithOverlays(true, gone));
    await mounted.unmount();

    expect(closeOverlays()).toBe(0);
    expect(hidden).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it("calls the newest onClose", async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = await renderHook(({ onClose }: { onClose: () => void }) => useCloseWithOverlays(true, onClose), {
      initialProps: { onClose: first },
    });
    await rerender({ onClose: second });

    closeOverlays();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
