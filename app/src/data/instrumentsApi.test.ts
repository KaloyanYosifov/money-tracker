import { createInstrumentsApi, type Instrument, type SearchResult } from "./instrumentsApi";

jest.mock("expo-device", () => ({ modelName: "iPhone 15" }));

function jsonResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const RESULTS: SearchResult[] = [{ symbol: "ACME", name: "Acme Corp", exchange: "NMS", kind: "stock" }];
const ACME: Instrument = {
  id: "inst-1",
  symbol: "ACME",
  name: "Acme Corp",
  exchange: "NMS",
  kind: "stock",
  quote_currency: "USD",
};

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

const api = createInstrumentsApi({ apiUrl: "https://money.test", platform: "native", getAccessToken: async () => "tok" });

describe("search", () => {
  it("sends a GET with the query and the bearer token and returns the results", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: RESULTS }));

    const result = await api.search("acme");

    expect(result).toEqual({ ok: true, value: RESULTS });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://money.test/api/instruments/search?q=acme");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["X-Client"]).toBe("native");
  });

  it("encodes the query", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [] }));

    await api.search("a&b c");

    expect(fetchMock.mock.calls[0][0]).toBe("https://money.test/api/instruments/search?q=a%26b%20c");
  });
});

describe("add", () => {
  it("sends a POST with the JSON body and returns the instrument", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, ACME));

    const result = await api.add("ACME");

    expect(result).toEqual({ ok: true, value: ACME });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://money.test/api/instruments");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ symbol: "ACME" });
  });
});

describe("errors", () => {
  it("returns network when fetch throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));

    expect(await api.search("acme")).toEqual({ ok: false, error: "network" });
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate_limited"],
    [404, "not_found"],
    [400, "server"],
    [503, "server"],
  ])("maps status %i to %s", async (status, error) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: "x" }));

    expect(await api.add("ACME")).toEqual({ ok: false, error });
  });

  it("returns server when the body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad");
      },
    } as unknown as Response);

    expect(await api.search("acme")).toEqual({ ok: false, error: "server" });
  });

  it("returns unauthorized without a token and sends no request", async () => {
    const noToken = createInstrumentsApi({ apiUrl: "https://money.test", platform: "native", getAccessToken: async () => null });

    expect(await noToken.search("acme")).toEqual({ ok: false, error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("web client", () => {
  it("sends X-Requested-With and includes credentials", async () => {
    const web = createInstrumentsApi({ apiUrl: "https://money.test", platform: "web", getAccessToken: async () => "tok" });
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [] }));

    await web.search("acme");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Requested-With"]).toBe("money-tracker");
    expect(init.headers["X-Client"]).toBeUndefined();
    expect(init.credentials).toBe("include");
  });
});
