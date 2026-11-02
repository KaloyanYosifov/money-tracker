import { asyncDatabase, createTestDatabase, loadFixture, type TestDatabase } from "../../test/sqlite";
import { toFixed } from "../domain/decimal";
import { instrumentDetail, loadPortfolio } from "./portfolio";

const today = "2026-10-19";

function fixed(text: string): bigint {
  const value = toFixed(text);
  if (value === null) throw new Error(`bad decimal ${text}`);
  return value;
}

function instrument(id: string, symbol: string, kind: string, quote_currency: string, fields: Record<string, unknown> = {}) {
  return { id, symbol, name: `${symbol} Test`, exchange: "TEST", kind, quote_currency, ...fields };
}

let seq = 0;
function trade(instrument_id: string, side: string, date: string, quantity: string, price: string, fee = "0") {
  seq += 1;
  return { id: `tr${String(seq).padStart(4, "0")}`, user_id: "u1", instrument_id, side, date, quantity, price, fee };
}

function price(instrument_id: string, date: string, close: string) {
  return { id: `${instrument_id}-${date}`, instrument_id, date, close, as_of: `${date}T20:00:00Z` };
}

let sqlite: TestDatabase;

beforeEach(() => {
  sqlite = createTestDatabase();
  loadFixture(sqlite, {
    instruments: [
      instrument("acme", "ACME", "stock", "USD", { last_fetched_at: "2026-10-19T10:00:00Z" }),
      instrument("beta", "BETA", "etf", "EUR"),
      instrument("gamma", "GAMMA", "stock", "USD", { failed_at: "2026-10-18T10:00:00Z" }),
      instrument("eurusd", "EURUSD=X", "fx", "USD"),
    ],
    instrument_prices: [
      price("acme", "2026-10-01", "100"),
      price("acme", "2026-10-15", "110"),
      price("acme", "2026-10-25", "999"),
      price("beta", "2026-10-01", "20"),
      price("beta", "2026-10-15", "26"),
      price("eurusd", "2026-09-01", "1.25"),
      price("eurusd", "2026-10-10", "1.1"),
    ],
    trades: [
      trade("acme", "buy", "2026-09-20", "10", "90", "1"),
      trade("acme", "sell", "2026-10-12", "2", "105"),
      trade("beta", "buy", "2026-09-25", "10", "20"),
      trade("beta", "sell", "2026-10-05", "10", "25"),
      trade("gamma", "buy", "2026-10-01", "3", "5"),
    ],
  });
});

afterEach(() => sqlite.close());

describe("loadPortfolio", () => {
  it("returns one holding for each instrument with an open quantity, largest value first", async () => {
    const portfolio = await loadPortfolio(asyncDatabase(sqlite), "EUR", today);

    expect(portfolio.holdings.map((h) => h.symbol)).toEqual(["ACME", "GAMMA"]);
  });

  it("gives the quote and app values, the profit and the price state of a holding", async () => {
    const portfolio = await loadPortfolio(asyncDatabase(sqlite), "EUR", today);

    expect(portfolio.holdings[0]).toEqual({
      instrumentId: "acme",
      symbol: "ACME",
      name: "ACME Test",
      exchange: "TEST",
      kind: "stock",
      quoteCurrency: "USD",
      quantity: fixed("8"),
      cost: fixed("720.8"),
      fees: fixed("1"),
      close: fixed("110"),
      closeDate: "2026-10-15",
      value: fixed("880"),
      openProfit: fixed("159.2"),
      realized: fixed("29.8"),
      app: {
        value: fixed("800"),
        cost: fixed("655.272727272727"),
        openProfit: fixed("144.727272727273"),
        realized: fixed("27.090909090909"),
      },
      lastFetchedAt: "2026-10-19T10:00:00Z",
      failed: false,
      prices: [
        { date: "2026-10-01", close: fixed("100") },
        { date: "2026-10-15", close: fixed("110") },
      ],
    });
  });

  it("shows a value of null for an instrument with no price", async () => {
    const gamma = (await loadPortfolio(asyncDatabase(sqlite), "EUR", today)).holdings[1];

    expect(gamma).toMatchObject({
      quantity: fixed("3"),
      cost: fixed("15"),
      close: null,
      closeDate: null,
      value: null,
      openProfit: null,
      app: { value: null, cost: fixed("13.636363636364"), openProfit: null, realized: 0n },
      lastFetchedAt: null,
      failed: true,
      prices: [],
    });
  });

  it("counts the realized profit of closed positions in the totals", async () => {
    const { totals } = await loadPortfolio(asyncDatabase(sqlite), "EUR", today);

    expect(totals).toEqual({
      value: fixed("800"),
      cost: fixed("655.272727272727"),
      openProfit: fixed("144.727272727273"),
      realized: fixed("77.090909090909"),
    });
  });

  it("gives the portfolio value on each price date and today", async () => {
    const { series } = await loadPortfolio(asyncDatabase(sqlite), "EUR", today);

    expect(series).toEqual([
      { date: "2026-10-01", value: fixed("1000") },
      { date: "2026-10-15", value: fixed("800") },
      { date: "2026-10-19", value: fixed("800") },
    ]);
  });

  it("needs no FX rate for the app currency, and leaves amounts without a rate out of the totals", async () => {
    const portfolio = await loadPortfolio(asyncDatabase(sqlite), "USD", today);

    expect(portfolio.holdings[0].app).toEqual({
      value: fixed("880"),
      cost: fixed("720.8"),
      openProfit: fixed("159.2"),
      realized: fixed("29.8"),
    });
    expect(portfolio.totals.realized).toBe(fixed("29.8"));
  });

  it("is empty without trades", async () => {
    sqlite.exec("DELETE FROM trades");

    expect(await loadPortfolio(asyncDatabase(sqlite), "EUR", today)).toEqual({
      holdings: [],
      totals: { value: 0n, cost: 0n, openProfit: 0n, realized: 0n },
      series: [],
    });
  });
});

describe("instrumentDetail", () => {
  it("returns a closed position with its trades, newest first", async () => {
    const detail = await instrumentDetail(asyncDatabase(sqlite), "beta", "EUR", today);

    expect(detail?.holding).toMatchObject({ quantity: 0n, realized: fixed("50"), app: { realized: fixed("50") } });
    expect(detail?.trades.map((t) => [t.date, t.side])).toEqual([
      ["2026-10-05", "sell"],
      ["2026-09-25", "buy"],
    ]);
  });

  it("returns null for an unknown instrument", async () => {
    expect(await instrumentDetail(asyncDatabase(sqlite), "missing", "EUR", today)).toBeNull();
  });
});
