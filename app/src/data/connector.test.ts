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

  it("splits a transaction of more than 200 ops into requests of at most 200 ops", async () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      entry(UpdateType.PUT, "transactions", `t${i}`, { amount_minor: i + 1 }),
    );
    const { db, complete, tx } = fakeDatabase(many);
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [{ index: 5, code: "invalid_record", message: "bad" }] }));
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));

    await createConnector(deps()).uploadData(db);

    const sizes = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string).ops.length);
    expect(sizes).toEqual([200, 200, 50]);
    const ids = fetchMock.mock.calls.flatMap(([, init]) =>
      JSON.parse(init?.body as string).ops.map((op: { id: string }) => op.id),
    );
    expect(ids).toEqual(many.map((e) => e.id));
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect((tx.execute.mock.calls[0] as unknown as [string, unknown[]])[1][2]).toBe("t205");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not complete when a later part of a split transaction fails", async () => {
    const many = Array.from({ length: 250 }, (_, i) => entry(UpdateType.DELETE, "transactions", `t${i}`));
    const { db, complete } = fakeDatabase(many);
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));
    fetchMock.mockResolvedValueOnce(respond(503, { error: "unavailable" }));

    await expect(createConnector(deps()).uploadData(db)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  // The ids of the ops in each request, in send order.
  function sentIds(): string[][] {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string).ops.map((op: { id: string }) => op.id));
  }

  // Answers 400 with the API error to every request that holds one of the bad ids, else 200.
  function failOn(...bad: string[]) {
    fetchMock.mockImplementation(async (_url, init) => {
      const ids: string[] = JSON.parse(init?.body as string).ops.map((op: { id: string }) => op.id);
      return ids.some((id) => bad.includes(id)) ? respond(400, { error: "invalid_request" }) : respond(200, { rejected: [] });
    });
  }

  it("records a single op as a sync problem on a permanent 400, then completes", async () => {
    const { db, complete, tx } = fakeDatabase([crud[1]]);
    fetchMock.mockResolvedValueOnce(respond(400, { error: "invalid_request" }));

    await createConnector(deps()).uploadData(db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = tx.execute.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1]);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(1, 4)).toEqual(["transactions", "t1", "PATCH"]);
    expect(rows[0][5]).toBe("invalid_request");
    expect(rows[0][6]).toEqual(expect.stringContaining("400"));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("splits a part on a permanent 400 until only the bad op is a sync problem", async () => {
    const { db, complete, tx } = fakeDatabase(crud);
    failOn("t1");

    await createConnector(deps()).uploadData(db);

    // [a1 t1 b1] fails, then [a1 t1] fails, [a1] passes, [t1] fails, [b1] passes.
    expect(sentIds()).toEqual([["a1", "t1", "b1"], ["a1", "t1"], ["a1"], ["t1"], ["b1"]]);
    const rows = tx.execute.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1]);
    expect(rows.map((r) => r.slice(2, 6))).toEqual([["t1", "PATCH", JSON.stringify({ amount_minor: 1250 }), "invalid_request"]]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("keeps the good ops of a 200-op part when one op makes the part fail", async () => {
    const many = Array.from({ length: 450 }, (_, i) => entry(UpdateType.DELETE, "transactions", `t${i}`));
    const { db, complete, tx } = fakeDatabase(many);
    failOn("t250", "t251");

    await createConnector(deps()).uploadData(db);

    // Every op goes out once in a request that passes, or alone in a request that fails, in order.
    const sent = sentIds();
    const passed = sent.filter((ids) => !ids.includes("t250") && !ids.includes("t251")).flat();
    expect(passed).toEqual(many.map((e) => e.id).filter((id) => id !== "t250" && id !== "t251"));
    expect(sent.filter((ids) => ids.length === 1 && (ids[0] === "t250" || ids[0] === "t251"))).toEqual([["t250"], ["t251"]]);
    const rows = tx.execute.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1]);
    expect(rows.map((r) => r[2])).toEqual(["t250", "t251"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("maps the rejections of a split part to the right ops", async () => {
    const { db, tx } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce(respond(400, { error: "invalid_request" }));
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [{ index: 0, code: "forbidden", message: "no" }] }));

    await createConnector(deps()).uploadData(db);

    expect(sentIds()).toEqual([["a1", "t1", "b1"], ["a1", "t1"], ["b1"]]);
    const rows = tx.execute.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1]);
    expect(rows.map((r) => r.slice(2, 6))).toEqual([["b1", "DELETE", null, "forbidden"]]);
  });

  it.each([
    ["a plain text body", () => Promise.reject(new SyntaxError("Unexpected token B"))],
    ["JSON without an error code", () => Promise.resolve({ message: "bad gateway" })],
  ])("throws on a 400 with %s, so PowerSync retries", async (_name, json) => {
    const { db, complete, tx } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json } as unknown as Response);

    await expect(createConnector(deps()).uploadData(db)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tx.execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses http_413 as the code when a single op is too large and the body is not JSON", async () => {
    const { db, complete, tx } = fakeDatabase([crud[0]]);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 413,
      json: async () => {
        throw new SyntaxError("Unexpected token r");
      },
    } as unknown as Response);

    await createConnector(deps()).uploadData(db);

    const rows = tx.execute.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1]);
    expect(rows).toHaveLength(1);
    expect(rows[0][5]).toBe("http_413");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("splits a part that is too large (413) into smaller requests", async () => {
    const { db, complete, tx } = fakeDatabase(crud);
    fetchMock.mockImplementation(async (_url, init) =>
      JSON.parse(init?.body as string).ops.length > 1 ? respond(413) : respond(200, { rejected: [] }),
    );

    await createConnector(deps()).uploadData(db);

    expect(sentIds()).toEqual([["a1", "t1", "b1"], ["a1", "t1"], ["a1"], ["t1"], ["b1"]]);
    expect(tx.execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("refreshes on a 401 in a split part and goes on with the new token", async () => {
    const { db, complete } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce(respond(400, { error: "invalid_request" }));
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));
    fetchMock.mockResolvedValueOnce(respond(401, { error: "unauthorized" }));
    fetchMock.mockResolvedValueOnce(respond(200, { rejected: [] }));

    await createConnector(deps()).uploadData(db);

    expect(sentIds()).toEqual([["a1", "t1", "b1"], ["a1", "t1"], ["b1"], ["b1"]]);
    expect((fetchMock.mock.calls[3][1]?.headers as Record<string, string>).Authorization).toBe("Bearer token-2");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 405, 408, 422, 429])("throws on %i and writes nothing, so PowerSync retries", async (status) => {
    const { db, complete, tx } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce(respond(status, { error: "later" }));

    await expect(createConnector(deps()).uploadData(db)).rejects.toThrow();
    expect(tx.execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
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

  it("throws when the retry after a refresh gets 401 again", async () => {
    const { db, complete, tx } = fakeDatabase(crud);
    fetchMock.mockResolvedValueOnce(respond(401, { error: "unauthorized" }));
    fetchMock.mockResolvedValueOnce(respond(401, { error: "unauthorized" }));

    await expect(createConnector(deps()).uploadData(db)).rejects.toThrow();
    expect(tx.execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
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
