jest.mock("react-native", () => ({ Platform: { OS: "web" } }));

describe("getPowerSyncUrl on the web", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    fetchMock.mockReset();
    global.fetch = fetchMock;
    delete process.env.EXPO_PUBLIC_POWERSYNC_URL;
    // The test window has no location, so API_URL needs a value.
    process.env.EXPO_PUBLIC_API_URL = "http://api.test";
  });

  function load(): typeof import("./config") {
    return require("./config");
  }

  it("reads the URL from /config.json one time", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ powersyncUrl: "https://sync.example" }) });
    const { getPowerSyncUrl } = load();
    await expect(getPowerSyncUrl()).resolves.toBe("https://sync.example");
    await expect(getPowerSyncUrl()).resolves.toBe("https://sync.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/config.json");
  });

  it("uses the build-time URL without a request", async () => {
    process.env.EXPO_PUBLIC_POWERSYNC_URL = "https://build.example";
    const { getPowerSyncUrl } = load();
    await expect(getPowerSyncUrl()).resolves.toBe("https://build.example");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty URL after a failed request and tries again on the next call", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ powersyncUrl: "https://sync.example" }) });
    const { getPowerSyncUrl } = load();
    await expect(getPowerSyncUrl()).resolves.toBe("");
    await expect(getPowerSyncUrl()).resolves.toBe("https://sync.example");
  });
});
