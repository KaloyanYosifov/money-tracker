import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import type { AuthApi, AuthResult, TokenResponse } from "./api";
import { AuthProvider, useAuth } from "./AuthProvider";

const mockStore: { refreshToken: string | null; lastUserId: string | null } = {
  refreshToken: null,
  lastUserId: null,
};

jest.mock("./tokenStore", () => ({
  getRefreshToken: async () => mockStore.refreshToken,
  setRefreshToken: async (token: string | null) => {
    mockStore.refreshToken = token;
  },
  getLastUserId: async () => mockStore.lastUserId,
  setLastUserId: async (id: string | null) => {
    mockStore.lastUserId = id;
  },
}));

function tokens(userId: string, n: number): TokenResponse {
  return {
    access_token: `access-${userId}-${n}`,
    expires_in: 600,
    user_id: userId,
    session_id: `session-${userId}`,
    refresh_token: `refresh-${userId}-${n}`,
  };
}

function mockApi(): jest.Mocked<AuthApi> {
  return {
    login: jest.fn(),
    loginTotp: jest.fn(),
    acceptInvite: jest.fn(),
    confirmInvite: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  };
}

let clock: number;
let api: jest.Mocked<AuthApi>;
let onUserChange: jest.Mock;

beforeEach(() => {
  clock = 1_000_000;
  api = mockApi();
  onUserChange = jest.fn();
  mockStore.refreshToken = null;
  mockStore.lastUserId = null;
});

async function renderAuth() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider api={api} onUserChange={onUserChange} now={() => clock}>
      {children}
    </AuthProvider>
  );
  return renderHook(() => useAuth(), { wrapper });
}

describe("start", () => {
  it("is loading, then signedIn when the refresh works", async () => {
    mockStore.refreshToken = "refresh-user-1-0";
    mockStore.lastUserId = "user-1";
    let resolve!: (r: AuthResult<TokenResponse>) => void;
    api.refresh.mockReturnValue(new Promise((r) => (resolve = r)));

    const { result } = await renderAuth();
    expect(result.current.status).toBe("loading");

    await act(async () => resolve({ ok: true, value: tokens("user-1", 1) }));
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    expect(result.current.userId).toBe("user-1");
    expect(result.current.sessionId).toBe("session-user-1");
    expect(api.refresh).toHaveBeenCalledWith("refresh-user-1-0");
    expect(mockStore.refreshToken).toBe("refresh-user-1-1");
  });

  it("is reauthRequired on refresh_invalid with a known last user", async () => {
    mockStore.refreshToken = "refresh-old";
    mockStore.lastUserId = "user-1";
    api.refresh.mockResolvedValue({ ok: false, error: "refresh_invalid" });

    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe("reauthRequired"));
    expect(result.current.userId).toBe("user-1");
    expect(mockStore.refreshToken).toBeNull();
  });

  it("is signedOut on refresh_invalid with no known user", async () => {
    mockStore.refreshToken = "refresh-old";
    api.refresh.mockResolvedValue({ ok: false, error: "refresh_invalid" });

    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe("signedOut"));
    expect(result.current.userId).toBeNull();
  });

  it("is signedOut with no stored refresh token and no known user", async () => {
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe("signedOut"));
    expect(api.refresh).not.toHaveBeenCalled();
  });
});

describe("getAccessToken", () => {
  async function signedIn() {
    mockStore.refreshToken = "refresh-user-1-0";
    mockStore.lastUserId = "user-1";
    api.refresh.mockResolvedValueOnce({ ok: true, value: tokens("user-1", 1) });
    const hook = await renderAuth();
    await waitFor(() => expect(hook.result.current.status).toBe("signedIn"));
    api.refresh.mockClear();
    return hook;
  }

  it("returns the cached token until 60 seconds before exp", async () => {
    const { result } = await signedIn();

    clock += 539_000;
    expect(await result.current.getAccessToken()).toBe("access-user-1-1");
    expect(api.refresh).not.toHaveBeenCalled();

    clock += 1_000;
    api.refresh.mockResolvedValueOnce({ ok: true, value: tokens("user-1", 2) });
    let token: string | null = null;
    await act(async () => {
      token = await result.current.getAccessToken();
    });
    expect(token).toBe("access-user-1-2");
    expect(api.refresh).toHaveBeenCalledWith("refresh-user-1-1");
    expect(mockStore.refreshToken).toBe("refresh-user-1-2");
  });

  it("shares one refresh between two calls at the same time", async () => {
    const { result } = await signedIn();
    clock += 600_000;
    api.refresh.mockResolvedValueOnce({ ok: true, value: tokens("user-1", 2) });

    let tokensOut: (string | null)[] = [];
    await act(async () => {
      tokensOut = await Promise.all([result.current.getAccessToken(), result.current.getAccessToken()]);
    });
    expect(tokensOut).toEqual(["access-user-1-2", "access-user-1-2"]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
  });

  it("moves to reauthRequired and returns null when the refresh is rejected", async () => {
    const { result } = await signedIn();
    clock += 600_000;
    api.refresh.mockResolvedValueOnce({ ok: false, error: "refresh_invalid" });

    let token: string | null = "x";
    await act(async () => {
      token = await result.current.getAccessToken();
    });
    expect(token).toBeNull();
    expect(result.current.status).toBe("reauthRequired");
  });
});

describe("refreshAccessToken", () => {
  it("refreshes even when the cached token is still valid", async () => {
    mockStore.refreshToken = "refresh-user-1-0";
    mockStore.lastUserId = "user-1";
    api.refresh.mockResolvedValueOnce({ ok: true, value: tokens("user-1", 1) });
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe("signedIn"));

    api.refresh.mockResolvedValueOnce({ ok: true, value: tokens("user-1", 2) });
    let token: string | null = null;
    await act(async () => {
      token = await result.current.refreshAccessToken();
    });
    expect(token).toBe("access-user-1-2");
    expect(api.refresh).toHaveBeenLastCalledWith("refresh-user-1-1");
  });
});

describe("signIn", () => {
  it("fires onUserChange before it publishes a different user", async () => {
    mockStore.refreshToken = "refresh-old";
    mockStore.lastUserId = "user-1";
    api.refresh.mockResolvedValue({ ok: false, error: "refresh_invalid" });
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe("reauthRequired"));

    const seen: { status: string; userId: string | null }[] = [];
    onUserChange.mockImplementation(async () => {
      seen.push({ status: result.current.status, userId: result.current.userId });
    });

    await act(async () => result.current.signIn(tokens("user-2", 1)));

    expect(onUserChange).toHaveBeenCalledWith("user-2", "user-1");
    expect(seen).toEqual([{ status: "reauthRequired", userId: "user-1" }]);
    expect(result.current.status).toBe("signedIn");
    expect(result.current.userId).toBe("user-2");
    expect(mockStore.lastUserId).toBe("user-2");
    expect(mockStore.refreshToken).toBe("refresh-user-2-1");
    expect(await result.current.getAccessToken()).toBe("access-user-2-1");
  });

  it("does not fire onUserChange when the same user signs in again", async () => {
    mockStore.refreshToken = "refresh-old";
    mockStore.lastUserId = "user-1";
    api.refresh.mockResolvedValue({ ok: false, error: "refresh_invalid" });
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe("reauthRequired"));

    await act(async () => result.current.signIn(tokens("user-1", 2)));

    expect(onUserChange).not.toHaveBeenCalled();
    expect(result.current.status).toBe("signedIn");
  });
});

describe("signOut", () => {
  const platform = jest.requireActual<typeof import("react-native")>("react-native").Platform;
  const original = platform.OS;
  afterEach(() => {
    platform.OS = original;
  });

  async function signedIn() {
    mockStore.refreshToken = "refresh-user-1-0";
    mockStore.lastUserId = "user-1";
    api.refresh.mockResolvedValue({ ok: true, value: tokens("user-1", 1) });
    const rendered = await renderAuth();
    await waitFor(() => expect(rendered.result.current.status).toBe("signedIn"));
    return rendered;
  }

  it("signs out on native also when the API call fails", async () => {
    const { result } = await signedIn();
    api.logout.mockResolvedValue({ ok: false, error: "network" });

    await act(async () => result.current.signOut());

    expect(result.current.status).toBe("signedOut");
    expect(mockStore.refreshToken).toBeNull();
  });

  it("rejects and stays signed in on the web when the API call fails", async () => {
    const { result } = await signedIn();
    platform.OS = "web";
    api.logout.mockResolvedValue({ ok: false, error: "network" });

    await act(async () => {
      await expect(result.current.signOut()).rejects.toThrow("logout failed");
    });

    expect(result.current.status).toBe("signedIn");
  });
});

describe("Web Locks", () => {
  afterEach(() => {
    delete (globalThis.navigator as { locks?: unknown }).locks;
  });

  it("sends the refresh inside a lock that all browser tabs share", async () => {
    let inLock = false;
    const request = jest.fn(async (_name: string, cb: () => Promise<unknown>) => {
      inLock = true;
      try {
        return await cb();
      } finally {
        inLock = false;
      }
    });
    Object.assign(globalThis.navigator, { locks: { request } });
    mockStore.refreshToken = "refresh-user-1-0";
    mockStore.lastUserId = "user-1";
    let calledInLock = false;
    api.refresh.mockImplementation(async () => {
      calledInLock = inLock;
      return { ok: true, value: tokens("user-1", 1) };
    });

    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    expect(request).toHaveBeenCalledWith("money-tracker-refresh", expect.any(Function));
    expect(calledInLock).toBe(true);
  });
});
