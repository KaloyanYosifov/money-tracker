import { UpdateType, type CommonPowerSyncDatabase, type CrudEntry } from "@powersync/common";

import { API_URL, POWERSYNC_URL } from "../config";
import { SCHEMA_VERSION } from "../generated/schema";
import { createConnector, type ConnectorDeps } from "./connector";

const NOW = new Date("2026-10-19T10:00:00.000Z");
const UPLOAD_URL = `${API_URL}/api/sync/upload`;

function entry(op: UpdateType, table: string, id: string, opData?: Record<string, unknown>): CrudEntry {
  return { op, table, id, opData } as CrudEntry;
}

function fakeDatabase(crud: CrudEntry[] | null) {
  const complete = jest.fn(async () => {});
  const tx = { execute: jest.fn(async () => ({})) };
  const db = {
    getNextCrudTransaction: jest.fn(async () => (crud ? { crud, complete } : null)),
    writeTransaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };
  return { db: db as unknown as CommonPowerSyncDatabase, raw: db, tx, complete };
}

function deps(overrides: Partial<ConnectorDeps> = {}): ConnectorDeps {
  return {
    getAccessToken: jest.fn(async () => "token-1"),
    refreshAccessToken: jest.fn(async () => "token-2"),
    onReauthRequired: jest.fn(),
    onUpdateRequired: jest.fn(),
    now: () => NOW,
    ...overrides,
  };
}

function respond(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const crud = [
  entry(UpdateType.PUT, "accounts", "a1", { name: "Wallet", sort_order: 0 }),
  entry(UpdateType.PATCH, "transactions", "t1", { amount_minor: 1250 }),
  entry(UpdateType.DELETE, "budgets", "b1"),
];

describe("fetchCredentials", () => {
  it("returns the PowerSync URL and the access token", async () => {
    const connector = createConnector(deps());
    await expect(connector.fetchCredentials()).resolves.toEqual({ endpoint: POWERSYNC_URL, token: "token-1" });
  });

  it("returns null when signed out", async () => {
    const connector = createConnector(deps({ getAccessToken: jest.fn(async () => null) }));
    await expect(connector.fetchCredentials()).resolves.toBeNull();
  });
});

describe("uploadData", () => {
  it("does nothing when the queue is empty", async () => {
    const { db } = fakeDatabase(null);
    await createConnector(deps()).uploadData(db);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the transaction and completes it on 200 without rejections", async () => {
    const { db, complete, tx } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));

    await createConnector(deps()).uploadData(db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(UPLOAD_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    expect(JSON.parse(init?.body as string)).toEqual({
      schema_version: SCHEMA_VERSION,
      ops: [
        { op: "PUT", table: "accounts", id: "a1", data: { name: "Wallet", sort_order: 0 } },
        { op: "PATCH", table: "transactions", id: "t1", data: { amount_minor: 1250 } },
        { op: "DELETE", table: "budgets", id: "b1" },
      ],
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("sends the user_settings flags as JSON booleans", async () => {
    const { db } = fakeDatabase([
      entry(UpdateType.PATCH, "user_settings", "s1", { budget_mode: 1, carry_over: 0, theme: "dark" }),
      entry(UpdateType.PUT, "user_settings", "s2", { hide_future: 0, show_note: 1 }),
    ]);
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));

    await createConnector(deps()).uploadData(db);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string).ops).toEqual([
      { op: "PATCH", table: "user_settings", id: "s1", data: { budget_mode: true, carry_over: false, theme: "dark" } },
      { op: "PUT", table: "user_settings", id: "s2", data: { hide_future: false, show_note: true } },
    ]);
  });

  it("writes one sync_problems row per rejected op, then completes", async () => {
    const { db, complete, tx } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce(
      respond(200, {
        rejected: [
          { index: 0, code: "invalid_record", message: "at '/name': too long" },
          { index: 2, code: "forbidden", message: "not your record" },
        ],
      }),
    );

    await createConnector(deps()).uploadData(db);

    expect(tx.execute).toHaveBeenCalledTimes(2);
    const rows = tx.execute.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1]);
    for (const [sql] of tx.execute.mock.calls as unknown as [string][]) {
      expect(sql).toMatch(/INSERT INTO sync_problems/);
    }
    expect(rows[0].slice(1)).toEqual([
      "accounts",
      "a1",
      "PUT",
      JSON.stringify({ name: "Wallet", sort_order: 0 }),
      "invalid_record",
      "at '/name': too long",
      NOW.toISOString(),
    ]);
    expect(rows[1].slice(1)).toEqual(["budgets", "b1", "DELETE", null, "forbidden", "not your record", NOW.toISOString()]);
    expect(rows[0][0]).not.toBe(rows[1][0]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    const { db, complete } = fakeDatabase(crud);
    const d = deps();
    fetchMock.mockResolvedValueOnce(respond(401, { error: "unauthorized" }));
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));

    await createConnector(d).uploadData(db);

    expect(d.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe("Bearer token-2");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("sets reauthRequired and throws when the refresh after 401 fails", async () => {
    const { db, complete } = fakeDatabase(crud);
    const d = deps({ refreshAccessToken: jest.fn(async () => null) });
    fetchMock.mockResolvedValueOnce(respond(401, { error: "unauthorized" }));

    await expect(createConnector(d).uploadData(db)).rejects.toThrow();

    expect(d.onReauthRequired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("throws without a request when no access token is available", async () => {
    const { db, complete } = fakeDatabase(crud);
    const d = deps({ getAccessToken: jest.fn(async () => null) });

    await expect(createConnector(d).uploadData(db)).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("sets updateRequired and throws on 426", async () => {
    const { db, complete } = fakeDatabase(crud);
    const d = deps();
    fetchMock.mockResolvedValueOnce(respond(426, { error: "upgrade_required" }));

    await expect(createConnector(d).uploadData(db)).rejects.toThrow();

    expect(d.onUpdateRequired).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("throws on a network error, so PowerSync retries", async () => {
    const { db, complete } = fakeDatabase(crud);
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    await expect(createConnector(deps()).uploadData(db)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  it("throws on 5xx, so PowerSync retries", async () => {
    const { db, complete } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce(respond(503, { error: "unavailable" }));

    await expect(createConnector(deps()).uploadData(db)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});
