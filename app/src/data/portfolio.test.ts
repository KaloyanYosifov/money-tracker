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

describe("swaps", () => {
  beforeEach(() => {
    sqlite.close();
    sqlite = createTestDatabase();
    loadFixture(sqlite, {
      instruments: [instrument("zza", "ZZA-USD", "crypto", "USD"), instrument("zzb", "ZZB-USD", "crypto", "USD")],
      instrument_prices: [
        price("zza", "2026-01-05", "2000"),
        price("zza", "2026-02-01", "2600"),
        price("zzb", "2026-02-01", "1"),
        price("zzb", "2026-03-01", "1.01"),
      ],
      trades: [trade("zza", "buy", "2026-01-05", "1", "2000")],
      swaps: [
        {
          id: "sw1",
          user_id: "u1",
          from_instrument_id: "zza",
          to_instrument_id: "zzb",
          date: "2026-02-01",
          from_quantity: "1",
          to_quantity: "2498",
          fee: "2",
          value: "2500",
          to_value: "2500",
        },
      ],
    });
  });

  it("moves the holding from the sold to the bought asset and realizes the sold one", async () => {
    const portfolio = await loadPortfolio(asyncDatabase(sqlite), "USD", today);

    expect(portfolio.holdings.map((h) => h.symbol)).toEqual(["ZZB-USD"]);
    expect(portfolio.holdings[0]).toMatchObject({ quantity: fixed("2498"), cost: fixed("2500"), fees: fixed("2") });
    expect(portfolio.totals.realized).toBe(fixed("500"));
  });

  it("counts the bought asset and not the sold one in the series from the swap date", async () => {
    const { series } = await loadPortfolio(asyncDatabase(sqlite), "USD", today);

    expect(series).toEqual([
      { date: "2026-01-05", value: fixed("2000") },
      { date: "2026-02-01", value: fixed("2498") },
      { date: "2026-03-01", value: fixed("2522.98") },
      { date: "2026-10-19", value: fixed("2522.98") },
    ]);
  });

  it("shows an asset that has only swap legs and no trades", async () => {
    const portfolio = await loadPortfolio(asyncDatabase(sqlite), "USD", today);

    expect(portfolio.holdings.map((h) => h.symbol)).toEqual(["ZZB-USD"]);
  });

  it("gives the swaps and the legs of the sold asset", async () => {
    const detail = await instrumentDetail(asyncDatabase(sqlite), "zza", "USD", today);

    expect(detail?.swaps.map((s) => s.id)).toEqual(["sw1"]);
    expect(detail?.trades.map((t) => [t.date, t.side])).toEqual([["2026-01-05", "buy"]]);
    expect(detail?.legs.map((t) => [t.date, t.side, t.quantity])).toEqual([
      ["2026-01-05", "buy", "1"],
      ["2026-02-01", "sell", "1"],
    ]);
  });

  it("gives the swaps and the buy leg of the bought asset", async () => {
    const detail = await instrumentDetail(asyncDatabase(sqlite), "zzb", "USD", today);

    expect(detail?.swaps.map((s) => s.id)).toEqual(["sw1"]);
    expect(detail?.trades).toEqual([]);
    expect(detail?.legs).toEqual([
      { id: "sw1", side: "buy", date: "2026-02-01", quantity: "2498", price: "0", fee: "2", total: "2498" },
    ]);
  });
});
