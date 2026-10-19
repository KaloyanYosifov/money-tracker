import { renderHook } from "@testing-library/react-native";

import { layoutModeFor, useLayoutMode } from "./useLayoutMode";

describe("layoutModeFor", () => {
  it("gives sidebar on the web at 900 px or more", () => {
    expect(layoutModeFor({ platform: "web", width: 900, height: 700, isTablet: false })).toBe("sidebar");
    expect(layoutModeFor({ platform: "web", width: 1280, height: 800, isTablet: false })).toBe("sidebar");
  });

  it("gives tabs on the web below 900 px", () => {
    expect(layoutModeFor({ platform: "web", width: 899, height: 700, isTablet: false })).toBe("tabs");
    expect(layoutModeFor({ platform: "web", width: 800, height: 400, isTablet: false })).toBe("tabs");
  });

  it("gives tabs on a native phone in portrait", () => {
    expect(layoutModeFor({ platform: "ios", width: 390, height: 844, isTablet: false })).toBe("tabs");
  });

  it("gives tabs on native also when the window is wide", () => {
    expect(layoutModeFor({ platform: "ios", width: 1024, height: 1366, isTablet: true })).toBe("tabs");
  });

  it("gives phoneLandscape on a native phone in landscape", () => {
    expect(layoutModeFor({ platform: "ios", width: 844, height: 390, isTablet: false })).toBe("phoneLandscape");
  });

  it("gives tabletSplit on an iPad in landscape", () => {
    expect(layoutModeFor({ platform: "ios", width: 1366, height: 1024, isTablet: true })).toBe("tabletSplit");
  });
});

describe("useLayoutMode", () => {
  it("reads the window size of the test device (iOS phone, portrait)", async () => {
    const { result } = await renderHook(() => useLayoutMode());
    expect(result.current).toBe("tabs");
  });
});
