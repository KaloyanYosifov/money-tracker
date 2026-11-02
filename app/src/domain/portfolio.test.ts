import { toFixed } from "./decimal";
import { deleteError, holding, rateOn, sellError, toApp, valueSeries, type Trade } from "./portfolio";

function fixed(text: string): bigint {
  const value = toFixed(text);
  if (value === null) throw new Error(`bad decimal ${text}`);
  return value;
}

function trade(id: string, side: "buy" | "sell", date: string, quantity: string, price: string, fee = "0"): Trade {
  return { id, side, date, quantity, price, fee };
}

describe("holding", () => {
  it("adds buy fees to the lot cost and takes sells from the oldest lot", () => {
    const result = holding([
      trade("a", "buy", "2026-01-05", "10", "80", "1"),
      trade("b", "buy", "2026-02-05", "5", "90"),
      trade("c", "sell", "2026-03-05", "4", "100"),
    ]);
    expect(result.quantity).toBe(fixed("11"));
    expect(result.cost).toBe(fixed("930.6"));
    expect(result.realized).toEqual([{ date: "2026-03-05", amount: fixed("79.6") }]);
    expect(result.fees).toBe(fixed("1"));
  });

  it("takes a sell over two lots and lowers the proceeds by the sell fee", () => {
    const result = holding([
      trade("a", "buy", "2026-01-05", "2", "10"),
      trade("b", "buy", "2026-01-06", "3", "20"),
      trade("c", "sell", "2026-01-07", "4", "30", "2"),
    ]);
    expect(result.realized).toEqual([{ date: "2026-01-07", amount: fixed("58") }]);
    expect(result.quantity).toBe(fixed("1"));
    expect(result.cost).toBe(fixed("20"));
    expect(result.fees).toBe(fixed("2"));
  });

  it("counts a buy before a sell on the same date", () => {
    const result = holding([
      trade("a", "sell", "2026-01-05", "5", "12"),
      trade("b", "buy", "2026-01-05", "5", "10"),
    ]);
    expect(result.quantity).toBe(0n);
    expect(result.cost).toBe(0n);
    expect(result.realized).toEqual([{ date: "2026-01-05", amount: fixed("10") }]);
  });

  it("keeps very small quantities exact", () => {
    const result = holding([trade("a", "buy", "2026-01-05", "0.00012345", "68120")]);
    expect(result.quantity).toBe(fixed("0.00012345"));
    expect(result.cost).toBe(fixed("8.409414"));
  });

  it("counts only the trades on or before a date", () => {
    const trades = [
      trade("a", "buy", "2026-01-05", "10", "80"),
      trade("b", "buy", "2026-02-05", "5", "90"),
    ];
    expect(holding(trades, "2026-01-31").quantity).toBe(fixed("10"));
    expect(holding(trades, "2026-01-04").quantity).toBe(0n);
  });
});

describe("sellError", () => {
  const held = [
    trade("a", "buy", "2026-01-05", "10", "80"),
    trade("b", "buy", "2026-02-05", "2", "90"),
  ];

  it("returns the held quantity when a sell is larger", () => {
    const sell = trade("new", "sell", "2026-03-01", "15", "100");
    expect(sellError(held, sell)).toEqual({ held: "12", sell });
  });

  it("allows a sell of all held units", () => {
    expect(sellError(held, trade("new", "sell", "2026-03-01", "12", "100"))).toBeNull();
  });

  it("excludes the old version of an edited sell", () => {
    const trades = [...held, trade("s", "sell", "2026-03-01", "12", "100")];
    expect(sellError(trades, trade("s", "sell", "2026-03-01", "11", "100"))).toBeNull();
    const larger = trade("s", "sell", "2026-03-01", "13", "100");
    expect(sellError(trades, larger)).toEqual({ held: "12", sell: larger });
  });

  it("allows a new buy dated before an existing sell", () => {
    const trades = [...held, trade("s", "sell", "2026-03-01", "12", "100")];
    expect(sellError(trades, trade("new", "buy", "2026-01-01", "3", "70"))).toBeNull();
  });

  it("returns the later sell that becomes too large, with the quantity held before it", () => {
    const later = trade("s", "sell", "2026-03-01", "8", "100");
    expect(sellError([...held, later], trade("new", "sell", "2026-01-20", "5", "95"))).toEqual({ held: "7", sell: later });
  });

  it("flags a sell before the new date of a buy that moves later", () => {
    const a = trade("a", "buy", "2026-01-05", "10", "80");
    const s = trade("s", "sell", "2026-03-01", "8", "100");
    expect(sellError([a, s], { ...a, date: "2026-04-01" })).toEqual({ held: "0", sell: s });
  });

  it("flags a sell that a lowered buy no longer covers", () => {
    const a = trade("a", "buy", "2026-01-05", "10", "80");
    const s = trade("s", "sell", "2026-03-01", "8", "100");
    expect(sellError([a, s], { ...a, quantity: "5" })).toEqual({ held: "5", sell: s });
  });

  it("ignores a sell that was already too large before the change", () => {
    const bad = trade("bad", "sell", "2026-01-10", "20", "100");
    const trades = [...held, bad];
    expect(sellError(trades, trade("new", "buy", "2026-04-01", "1", "70"))).toBeNull();
  });
});

describe("deleteError", () => {
  const a = trade("a", "buy", "2026-01-05", "10", "80");
  const b = trade("b", "buy", "2026-02-05", "2", "90");
  const s = trade("s", "sell", "2026-03-01", "8", "100");

  it("returns the sell that the delete leaves too large", () => {
    expect(deleteError([a, b, s], "a")).toEqual({ held: "2", sell: s });
  });

  it("allows a delete that keeps every sell covered", () => {
    expect(deleteError([a, b, s], "b")).toBeNull();
    expect(deleteError([a, b, s], "s")).toBeNull();
  });
});

describe("rateOn", () => {
  const closes = [
    { date: "2026-01-02", close: "1.08" },
    { date: "2026-01-05", close: "1.1" },
  ];

  it("returns the close of the date, else the latest earlier close", () => {
    expect(rateOn(closes, "2026-01-05")).toBe(fixed("1.1"));
    expect(rateOn(closes, "2026-01-04")).toBe(fixed("1.08"));
    expect(rateOn(closes, "2026-02-01")).toBe(fixed("1.1"));
  });

  it("returns null without an earlier close", () => {
    expect(rateOn(closes, "2026-01-01")).toBeNull();
    expect(rateOn([], "2026-01-01")).toBeNull();
  });
});

describe("toApp", () => {
  it("returns the amount for the same currency", () => {
    expect(toApp(fixed("12.5"), "EUR", "EUR", null)).toBe(fixed("12.5"));
  });

  it("returns null without a rate", () => {
    expect(toApp(fixed("12.5"), "USD", "EUR", null)).toBeNull();
  });

  it("divides by the rate", () => {
    expect(toApp(fixed("2895.1"), "USD", "EUR", fixed("1.0846"))).toBe(fixed("2669.278996865204"));
  });
});

describe("valueSeries", () => {
  it("sums open quantity times the close, converted with the rate on or before each date", () => {
    const usd = {
      quoteCurrency: "USD",
      trades: [trade("a", "buy", "2026-01-02", "10", "50")],
      closes: [
        { date: "2026-01-01", close: "50" },
        { date: "2026-01-03", close: "60" },
      ],
      fxCloses: [{ date: "2026-01-02", close: "1.25" }],
    };
    const eur = {
      quoteCurrency: "EUR",
      trades: [trade("b", "buy", "2026-01-01", "2", "90")],
      closes: [{ date: "2026-01-03", close: "100" }],
      fxCloses: [],
    };
    expect(valueSeries([usd, eur], ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"], "EUR")).toEqual([
      { date: "2026-01-01", value: 0n },
      { date: "2026-01-02", value: fixed("400") },
      { date: "2026-01-03", value: fixed("680") },
      { date: "2026-01-04", value: fixed("680") },
    ]);
  });

  it("counts an instrument without an FX rate as 0", () => {
    const usd = {
      quoteCurrency: "USD",
      trades: [trade("a", "buy", "2026-01-01", "1", "50")],
      closes: [{ date: "2026-01-01", close: "50" }],
      fxCloses: [],
    };
    expect(valueSeries([usd], ["2026-01-01"], "EUR")).toEqual([{ date: "2026-01-01", value: 0n }]);
  });
});
