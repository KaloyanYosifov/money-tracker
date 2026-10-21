import { createAuthApi, webDeviceName, type TokenResponse } from "./api";

jest.mock("expo-device", () => ({ modelName: "iPhone 15" }));

const TOKENS: TokenResponse = {
  access_token: "access",
  expires_in: 600,
  user_id: "user-1",
  session_id: "session-1",
  refresh_token: "refresh-2",
};

function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

function lastRequest(): { url: string; init: RequestInit; headers: Record<string, string>; body: unknown } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
}

describe("native client", () => {
  const api = createAuthApi({ apiUrl: "https://money.test", platform: "native" });

  it("sends X-Client and X-Device-Name on every auth call", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, TOKENS));
    await api.login("a@b.c", "password-long-enough");
    await api.loginTotp({ mfaToken: "mfa", code: "123456" });
    await api.acceptInvite("invite", "password-long-enough");
    await api.confirmInvite("invite", "123456");
    await api.refresh("refresh-1");
    fetchMock.mockResolvedValue(jsonResponse(204));
    await api.logout("refresh-1");

    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers["X-Client"]).toBe("native");
      expect(init.headers["X-Device-Name"]).toBe("iPhone 15");
    }
  });

  it("sends the refresh token in the body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, TOKENS));
    const result = await api.refresh("refresh-1");

    const req = lastRequest();
    expect(req.url).toBe("https://money.test/api/auth/refresh");
    expect(req.init.method).toBe("POST");
    expect(req.body).toEqual({ refresh_token: "refresh-1" });
    expect(result).toEqual({ ok: true, value: TOKENS });
  });
});

describe("web client", () => {
  const api = createAuthApi({ apiUrl: "https://money.test", platform: "web" });

  it("refresh sends credentials and X-Requested-With, and no token in the body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ...TOKENS, refresh_token: undefined }));
    await api.refresh(null);

    const req = lastRequest();
    expect(req.init.credentials).toBe("include");
    expect(req.headers["X-Requested-With"]).toBe("money-tracker");
    expect(req.headers["X-Client"]).toBeUndefined();
    expect(req.body).toBeUndefined();
  });

  it("login sends credentials so that the cookie is stored", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { mfa_token: "mfa" }));
    const result = await api.login("a@b.c", "password-long-enough");

    expect(lastRequest().init.credentials).toBe("include");
    expect(lastRequest().body).toEqual({ email: "a@b.c", password: "password-long-enough" });
    expect(result).toEqual({ ok: true, value: { mfa_token: "mfa" } });
  });
});

describe("error mapping", () => {
  const api = createAuthApi({ apiUrl: "https://money.test", platform: "native" });

  it.each([
    [401, "invalid_credentials"],
    [401, "invalid_code"],
    [429, "locked"],
    [403, "setup_incomplete"],
    [401, "refresh_invalid"],
  ])("maps %i %s to a typed error", async (status, code) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: code }));
    expect(await api.login("a@b.c", "x")).toEqual({ ok: false, error: code });
  });

  it("maps a fetch failure to network", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    expect(await api.refresh("refresh-1")).toEqual({ ok: false, error: "network" });
  });

  it("maps an unknown error or a body that is not JSON to server", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "internal" }));
    expect(await api.refresh("refresh-1")).toEqual({ ok: false, error: "server" });

    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Response);
    expect(await api.refresh("refresh-1")).toEqual({ ok: false, error: "server" });
  });
});

describe("web device name", () => {
  const MAC_CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const IPHONE_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
  const WINDOWS_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

  it("names the browser and the system", () => {
    expect(webDeviceName(MAC_CHROME)).toBe("Chrome on macOS");
    expect(webDeviceName(IPHONE_SAFARI)).toBe("Safari on iOS");
    expect(webDeviceName(WINDOWS_FIREFOX)).toBe("Firefox on Windows");
  });

  it("goes in the body of the calls that start a session, and not in refresh", async () => {
    const api = createAuthApi({ apiUrl: "https://money.test", platform: "web", deviceName: "Chrome on macOS" });
    fetchMock.mockResolvedValue(jsonResponse(200, TOKENS));

    await api.login("a@b.c", "password-long-enough");
    expect(lastRequest().body).toEqual({
      email: "a@b.c",
      password: "password-long-enough",
      device_name: "Chrome on macOS",
    });
    await api.loginTotp({ mfaToken: "mfa", code: "123456" });
    expect(lastRequest().body).toMatchObject({ mfa_token: "mfa", device_name: "Chrome on macOS" });
    await api.confirmInvite("invite", "123456");
    expect(lastRequest().body).toMatchObject({ token: "invite", device_name: "Chrome on macOS" });
    await api.refresh(null);
    expect(lastRequest().body).toBeUndefined();
  });
});
