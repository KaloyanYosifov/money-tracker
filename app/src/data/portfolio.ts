import { useMemo } from "react";
import { useQuery } from "@powersync/react";

import type { Instrument, InstrumentPrice, Trade as TradeRecord } from "../generated/schema";
import { mul, toFixed } from "../domain/decimal";
import { today as localToday } from "../domain/period";
import { holding, rateOn, sortTrades, toApp, valueSeries, type Close, type Trade } from "../domain/portfolio";
import type { SqlRunner } from "./mutations";

export type TradeRow = Pick<TradeRecord, "id" | "instrument_id" | "side" | "date" | "quantity" | "price" | "fee"> & {
  note: string | null;
};
export type InstrumentRow = Omit<Instrument, "last_fetched_at" | "failed_at"> & {
  last_fetched_at: string | null;
  failed_at: string | null;
};
type PriceRow = Pick<InstrumentPrice, "instrument_id" | "date" | "close">;

interface PortfolioRows {
  trades: TradeRow[];
  instruments: InstrumentRow[];
  prices: PriceRow[];
}

const tradesSql = "SELECT id, instrument_id, side, date, quantity, price, fee, note FROM trades";
const instrumentsSql = "SELECT * FROM instruments";
// Takes one parameter: today.
const pricesSql = "SELECT instrument_id, date, close FROM instrument_prices WHERE date <= ? ORDER BY date";

/** Amounts in the app currency. Null when no FX rate exists. */
export interface AppAmounts {
  value: bigint | null;
  cost: bigint | null;
  openProfit: bigint | null;
  realized: bigint | null;
}

/** All amounts are fixed values of decimal.ts. Without app, they are in the quote currency. */
export interface PortfolioHolding {
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  kind: Instrument["kind"];
  quoteCurrency: string;
  quantity: bigint;
  cost: bigint;
  fees: bigint;
  close: bigint | null;
  closeDate: string | null;
  value: bigint | null;
  openProfit: bigint | null;
  realized: bigint;
  app: AppAmounts;
  lastFetchedAt: string | null;
  failed: boolean;
  prices: { date: string; close: bigint }[];
}

/** Totals in the app currency. Amounts without an FX rate are left out. */
export interface Portfolio {
  holdings: PortfolioHolding[];
  totals: { value: bigint; cost: bigint; openProfit: bigint; realized: bigint };
  series: { date: string; value: bigint }[];
}

export interface InstrumentDetail {
  instrument: InstrumentRow;
  holding: PortfolioHolding;
  /** Newest first. */
  trades: TradeRow[];
}

function fixed(text: string): bigint {
  return toFixed(text) ?? 0n;
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, v) => total + v, 0n);
}

function fxPair(instruments: InstrumentRow[], quoteCurrency: string, appCurrency: string): InstrumentRow | undefined {
  const symbol = `${appCurrency}${quoteCurrency}=X`;
  return instruments.find((i) => i.kind === "fx" && i.symbol === symbol);
}

function closesOf(rows: PortfolioRows, instrumentId: string | undefined): Close[] {
  if (instrumentId === undefined) return [];
  return rows.prices.filter((p) => p.instrument_id === instrumentId).map((p) => ({ date: p.date, close: p.close }));
}

function tradesOf(rows: PortfolioRows, instrumentId: string): Trade[] {
  return rows.trades.filter((t) => t.instrument_id === instrumentId);
}

function summarize(rows: PortfolioRows, instrument: InstrumentRow, appCurrency: string, today: string): PortfolioHolding {
  const quoteCurrency = instrument.quote_currency;
  const closes = closesOf(rows, instrument.id);
  const fxCloses = closesOf(rows, fxPair(rows.instruments, quoteCurrency, appCurrency)?.id);
  const lots = holding(tradesOf(rows, instrument.id));
  const last = closes.at(-1);
  const close = last ? fixed(last.close) : null;
  const value = close === null ? null : mul(lots.quantity, close);
  const openProfit = value === null ? null : value - lots.cost;

  const rate = rateOn(fxCloses, today);
  const toAppNow = (amount: bigint | null) => (amount === null ? null : toApp(amount, quoteCurrency, appCurrency, rate));
  const realizedApp = lots.realized.map((r) => toApp(r.amount, quoteCurrency, appCurrency, rateOn(fxCloses, r.date)));

  return {
    instrumentId: instrument.id,
    symbol: instrument.symbol,
    name: instrument.name,
    exchange: instrument.exchange,
    kind: instrument.kind,
    quoteCurrency,
    quantity: lots.quantity,
    cost: lots.cost,
    fees: lots.fees,
    close,
    closeDate: last?.date ?? null,
    value,
    openProfit,
    realized: sum(lots.realized.map((r) => r.amount)),
    app: {
      value: toAppNow(value),
      cost: toAppNow(lots.cost),
      openProfit: toAppNow(openProfit),
      realized: realizedApp.some((r) => r === null) ? null : sum(realizedApp as bigint[]),
    },
    lastFetchedAt: instrument.last_fetched_at,
    failed: instrument.failed_at !== null,
    prices: closes.map((c) => ({ date: c.date, close: fixed(c.close) })),
  };
}

function seriesDates(rows: PortfolioRows, instruments: InstrumentRow[], today: string): string[] {
  if (rows.trades.length === 0) return [];
  const first = rows.trades.reduce((min, t) => (t.date < min ? t.date : min), rows.trades[0].date);
  const ids = new Set(instruments.map((i) => i.id));
  const dates = new Set(rows.prices.filter((p) => ids.has(p.instrument_id) && p.date >= first).map((p) => p.date));
  dates.add(today);
  return [...dates].sort();
}

function compareHoldings(a: PortfolioHolding, b: PortfolioHolding): number {
  const av = a.app.value;
  const bv = b.app.value;
  if (av !== bv) {
    if (av === null) return 1;
    if (bv === null) return -1;
    return av > bv ? -1 : 1;
  }
  return a.symbol.localeCompare(b.symbol);
}

/** Prices in rows must be on or before today and sorted by date. */
export function buildPortfolio(rows: PortfolioRows, appCurrency: string, today: string): Portfolio {
  const traded = new Set(rows.trades.map((t) => t.instrument_id));
  const instruments = rows.instruments.filter((i) => i.kind !== "fx" && traded.has(i.id));
  const all = instruments.map((i) => summarize(rows, i, appCurrency, today));
  const priced = all.filter((h) => h.app.value !== null && h.app.cost !== null);
  const known = (values: (bigint | null)[]) => sum(values.filter((v): v is bigint => v !== null));

  const series = valueSeries(
    instruments.map((i) => ({
      quoteCurrency: i.quote_currency,
      trades: tradesOf(rows, i.id),
      closes: closesOf(rows, i.id),
      fxCloses: closesOf(rows, fxPair(rows.instruments, i.quote_currency, appCurrency)?.id),
    })),
    seriesDates(rows, instruments, today),
    appCurrency,
  );

  return {
    holdings: all.filter((h) => h.quantity > 0n).sort(compareHoldings),
    totals: {
      value: known(priced.map((h) => h.app.value)),
      cost: known(priced.map((h) => h.app.cost)),
      openProfit: known(all.map((h) => h.app.openProfit)),
      realized: known(all.map((h) => h.app.realized)),
    },
    series,
  };
}

export function buildInstrumentDetail(
  rows: PortfolioRows,
  instrumentId: string,
  appCurrency: string,
  today: string,
): InstrumentDetail | null {
  const instrument = rows.instruments.find((i) => i.id === instrumentId);
  if (!instrument) return null;
  const trades = sortTrades(rows.trades.filter((t) => t.instrument_id === instrumentId)).reverse() as TradeRow[];
  return { instrument, holding: summarize(rows, instrument, appCurrency, today), trades };
}

async function loadRows(db: SqlRunner, today: string): Promise<PortfolioRows> {
  return {
    trades: await db.getAll<TradeRow>(tradesSql),
    instruments: await db.getAll<InstrumentRow>(instrumentsSql),
    prices: await db.getAll<PriceRow>(pricesSql, [today]),
  };
}

export async function loadPortfolio(db: SqlRunner, appCurrency: string, today: string): Promise<Portfolio> {
  return buildPortfolio(await loadRows(db, today), appCurrency, today);
}

export async function instrumentDetail(
  db: SqlRunner,
  instrumentId: string,
  appCurrency: string,
  today: string,
): Promise<InstrumentDetail | null> {
  return buildInstrumentDetail(await loadRows(db, today), instrumentId, appCurrency, today);
}

// Hooks. useQuery watches the tables in the SQL, so the screens update on each change.

function usePortfolioRows() {
  const today = localToday();
  const settings = useQuery<{ currency_code: string }>("SELECT currency_code FROM user_settings LIMIT 1");
  const trades = useQuery<TradeRow>(tradesSql);
  const instruments = useQuery<InstrumentRow>(instrumentsSql);
  const prices = useQuery<PriceRow>(pricesSql, [today]);
  const rows = useMemo(
    () => ({ trades: trades.data, instruments: instruments.data, prices: prices.data }),
    [trades.data, instruments.data, prices.data],
  );
  return {
    rows,
    today,
    appCurrency: settings.data[0]?.currency_code ?? null,
    isLoading: settings.isLoading || trades.isLoading || instruments.isLoading || prices.isLoading,
  };
}

/** The portfolio in the app currency. Null until the settings row is synced. */
export function usePortfolio() {
  const { rows, today, appCurrency, isLoading } = usePortfolioRows();
  const data = useMemo(
    () => (appCurrency === null ? null : buildPortfolio(rows, appCurrency, today)),
    [rows, appCurrency, today],
  );
  return { data, isLoading };
}

/** One instrument with its holding and trades, for the detail screen. */
export function useInstrument(instrumentId: string) {
  const { rows, today, appCurrency, isLoading } = usePortfolioRows();
  const data = useMemo(
    () => (appCurrency === null ? null : buildInstrumentDetail(rows, instrumentId, appCurrency, today)),
    [rows, instrumentId, appCurrency, today],
  );
  return { data, isLoading };
}
