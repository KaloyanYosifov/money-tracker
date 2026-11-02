import { div, fromFixed, mul, toFixed } from "./decimal";

export type Trade = {
  id: string;
  side: "buy" | "sell";
  date: string;
  quantity: string;
  price: string;
  fee: string;
};

export type Close = { date: string; close: string };

/** Quantities and amounts are fixed values of decimal.ts, in the quote currency of the instrument. */
export type Holding = {
  quantity: bigint;
  cost: bigint;
  fees: bigint;
  realized: { date: string; amount: bigint }[];
};

export type PortfolioInstrument = {
  quoteCurrency: string;
  trades: Trade[];
  closes: Close[];
  fxCloses: Close[];
};

function value(text: string): bigint {
  return toFixed(text) ?? 0n;
}

/** Sorts by date, then buys before sells on the same date, then id. */
export function sortTrades(trades: Trade[]): Trade[] {
  return [...trades].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** FIFO lots of the trades on or before onDate (all trades without it). */
export function holding(trades: Trade[], onDate?: string): Holding {
  const lots: { quantity: bigint; cost: bigint }[] = [];
  const realized: Holding["realized"] = [];
  let fees = 0n;
  for (const t of sortTrades(trades)) {
    if (onDate !== undefined && t.date > onDate) break;
    const quantity = value(t.quantity);
    const fee = value(t.fee);
    fees += fee;
    if (t.side === "buy") {
      lots.push({ quantity, cost: mul(quantity, value(t.price)) + fee });
      continue;
    }
    let rest = quantity;
    let cost = 0n;
    while (rest > 0n && lots.length > 0) {
      const lot = lots[0];
      if (lot.quantity <= rest) {
        rest -= lot.quantity;
        cost += lot.cost;
        lots.shift();
      } else {
        const part = (lot.cost * rest) / lot.quantity;
        lot.quantity -= rest;
        lot.cost -= part;
        cost += part;
        rest = 0n;
      }
    }
    realized.push({ date: t.date, amount: mul(quantity, value(t.price)) - fee - cost });
  }
  return {
    quantity: lots.reduce((sum, lot) => sum + lot.quantity, 0n),
    cost: lots.reduce((sum, lot) => sum + lot.cost, 0n),
    fees,
    realized,
  };
}

/** A sell that sells more than is held, and the quantity held just before it. */
export type Oversell = { held: string; sell: Trade };

function oversells(trades: Trade[]): Oversell[] {
  const result: Oversell[] = [];
  let running = 0n;
  for (const t of sortTrades(trades)) {
    const quantity = value(t.quantity);
    if (t.side === "buy") {
      running += quantity;
      continue;
    }
    if (quantity > running) result.push({ held: fromFixed(running > 0n ? running : 0n), sell: t });
    running -= quantity;
  }
  return result;
}

/**
 * The first sell that is too large after the change and was not too large before it.
 * The changed trade itself is always checked. Sells that were already too large do not block the change.
 */
function changeError(before: Trade[], after: Trade[], changedId?: string): Oversell | null {
  const old = new Set(oversells(before).map((o) => o.sell.id));
  return oversells(after).find((o) => o.sell.id === changedId || !old.has(o.sell.id)) ?? null;
}

/** Checks the trades with the candidate in place of its old version. */
export function sellError(trades: Trade[], candidate: Trade): Oversell | null {
  return changeError(trades, [...trades.filter((t) => t.id !== candidate.id), candidate], candidate.id);
}

/** Checks the trades without the trade id. */
export function deleteError(trades: Trade[], id: string): Oversell | null {
  return changeError(trades, trades.filter((t) => t.id !== id));
}

function sortCloses(closes: Close[]): Close[] {
  return [...closes].sort((a, b) => a.date.localeCompare(b.date));
}

/** The close on date in closes sorted by date, else the latest earlier close. */
function closeOn(sorted: Close[], date: string): bigint | null {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid].date <= date) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? null : value(sorted[low - 1].close);
}

export function rateOn(fxCloses: Close[], date: string): bigint | null {
  return closeOn(sortCloses(fxCloses), date);
}

/** Converts a quote amount to the app currency. The rate is quote units for one app unit. */
export function toApp(amount: bigint, quoteCurrency: string, appCurrency: string, rate: bigint | null): bigint | null {
  if (quoteCurrency === appCurrency) return amount;
  if (rate === null || rate === 0n) return null;
  return div(amount, rate);
}

/** Portfolio value in the app currency on each date. Instruments without a close or FX rate on a date count 0. */
export function valueSeries(
  instruments: PortfolioInstrument[],
  dates: string[],
  appCurrency: string,
): { date: string; value: bigint }[] {
  const prepared = instruments.map((i) => ({
    quoteCurrency: i.quoteCurrency,
    trades: i.trades,
    closes: sortCloses(i.closes),
    fxCloses: sortCloses(i.fxCloses),
  }));
  return dates.map((date) => {
    let total = 0n;
    for (const i of prepared) {
      const quantity = holding(i.trades, date).quantity;
      if (quantity === 0n) continue;
      const close = closeOn(i.closes, date);
      if (close === null) continue;
      total += toApp(mul(quantity, close), i.quoteCurrency, appCurrency, closeOn(i.fxCloses, date)) ?? 0n;
    }
    return { date, value: total };
  });
}
