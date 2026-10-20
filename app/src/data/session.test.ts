import { createElement, useEffect, type ComponentProps, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import type { AuthApi, AuthResult, TokenResponse } from "../auth/api";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { clearOnUserChange, logout, resetLocalData, unsyncedMessage, type SessionDb } from "./session";

const mockStore: { refreshToken: string | null; lastUserId: string | null } = {
  refreshToken: null,
  lastUserId: null,
};

jest.mock("../auth/tokenStore", () => ({
  getRefreshToken: async () => mockStore.refreshToken,
  setRefreshToken: async (token: string | null) => {
    mockStore.refreshToken = token;
  },
  getLastUserId: async () => mockStore.lastUserId,
  setLastUserId: async (id: string | null) => {
    mockStore.lastUserId = id;
  },
}));

// The wrappers pass children as the third createElement argument, so children is optional here.
const Provider = AuthProvider as (
  props: Omit<ComponentProps<typeof AuthProvider>, "children"> & { children?: ReactNode },
) => ReactNode;

let calls: string[];

function fakeDb(pending: number): SessionDb & { disconnectAndClear: jest.Mock } {
  return {
    getOptional: jest.fn(async () => ({ n: pending })) as SessionDb["getOptional"],
    disconnectAndClear: jest.fn(async () => {
      calls.push("disconnectAndClear");
    }),
  };
}

function mockApi(): jest.Mocked<AuthApi> {
  return {
    login: jest.fn(),
    loginTotp: jest.fn(),
    acceptInvite: jest.fn(),
    confirmInvite: jest.fn(),
    refresh: jest.fn(async (_token: string | null): Promise<AuthResult<TokenResponse>> => ({ ok: false, error: "refresh_invalid" })),
    logout: jest.fn(async (_token: string | null): Promise<AuthResult<void>> => {
      calls.push("api.logout");
      return { ok: true, value: undefined };
    }),
  };
}

beforeEach(() => {
  calls = [];
  mockStore.refreshToken = null;
  mockStore.lastUserId = null;
});

describe("unsyncedMessage", () => {
  it("names the number of changes", () => {
    expect(unsyncedMessage(2)).toBe("2 changes are not synced yet and will be lost");
    expect(unsyncedMessage(1)).toBe("1 change is not synced yet and will be lost");
  });
});

describe("logout", () => {
  it("calls the API logout, clears the tokens and clears the database", async () => {
    mockStore.refreshToken = "refresh-1";
    mockStore.lastUserId = "user-1";
    const api = mockApi();
    api.refresh.mockResolvedValue({
      ok: true,
      value: { access_token: "a", expires_in: 600, user_id: "user-1", session_id: "s1", refresh_token: "refresh-2" },
    });
    const { result } = await renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(Provider, { api }, children),
    });
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    const db = fakeDb(0);
    const confirm = jest.fn(async () => true);

    let done = false;
    await act(async () => {
      done = await logout({ db, signOut: result.current.signOut, confirm });
    });

    expect(done).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.logout).toHaveBeenCalledWith("refresh-2");
    expect(mockStore.refreshToken).toBeNull();
    expect(mockStore.lastUserId).toBeNull();
    expect(db.disconnectAndClear).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("signedOut");
  });

  it("asks first when the upload queue is not empty", async () => {
    const db = fakeDb(2);
    const signOut = jest.fn(async () => {});
    const confirm = jest.fn(async () => true);

    await logout({ db, signOut, confirm });

    expect(confirm).toHaveBeenCalledWith("2 changes are not synced yet and will be lost", "Log out");
    expect(signOut).toHaveBeenCalled();
    expect(db.disconnectAndClear).toHaveBeenCalled();
  });

  it("does nothing when the user cancels", async () => {
    const db = fakeDb(2);
    const signOut = jest.fn(async () => {});

    const done = await logout({ db, signOut, confirm: async () => false });

    expect(done).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
    expect(db.disconnectAndClear).not.toHaveBeenCalled();
  });
});

describe("clearOnUserChange", () => {
  it("clears the database before the app connects as the new user", async () => {
    mockStore.lastUserId = "user-1";
    const api = mockApi();
    const db = fakeDb(0);

    function Connect({ children }: { children: ReactNode }) {
      const { status } = useAuth();
      useEffect(() => {
        if (status === "signedIn") calls.push("connect");
      }, [status]);
      return children;
    }
    const { result } = await renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(Provider, { api, onUserChange: clearOnUserChange(db) }, createElement(Connect, null, children)),
    });
    await waitFor(() => expect(result.current.status).toBe("reauthRequired"));

    await act(() =>
      result.current.signIn({ access_token: "a", expires_in: 600, user_id: "user-2", session_id: "s2", refresh_token: "r" }),
    );

    expect(calls).toEqual(["disconnectAndClear", "connect"]);
  });
});

describe("resetLocalData", () => {
  it("clears and reconnects without a question when nothing is pending", async () => {
    const db = fakeDb(0);
    const connect = jest.fn(async () => {
      calls.push("connect");
    });
    const confirm = jest.fn(async () => true);

    expect(await resetLocalData({ db, connect, confirm })).toBe(true);

    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(["disconnectAndClear", "connect"]);
  });

  it("asks first when changes are pending, and stops on cancel", async () => {
    const db = fakeDb(1);
    const connect = jest.fn(async () => {});
    const confirm = jest.fn(async () => false);

    expect(await resetLocalData({ db, connect, confirm })).toBe(false);

    expect(confirm).toHaveBeenCalledWith("1 change is not synced yet and will be lost", "Reset");
    expect(db.disconnectAndClear).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
