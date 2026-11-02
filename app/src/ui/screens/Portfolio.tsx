import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";

import { usePortfolio, type PortfolioHolding } from "../../data/portfolio";
import { useAccountsTotal } from "../../data/queries";
import { fromFixed, toMinor } from "../../domain/decimal";
import { formatAmount, minorUnits, withPlus } from "../../domain/money";
import { today as localToday } from "../../domain/period";
import { LineChart } from "../charts/LineChart";
import { isHovered } from "../components/interaction";
import { PaperBar } from "../components/PaperBar";
import { SegmentedControl } from "../components/SegmentedControl";
import { useBottomInset } from "../nav/bottomInset";
import { Texture } from "../Texture";
import { paperTint, summaryFontFamily, type ThemeColors } from "../theme";
import { useScreenSettings } from "./manage";

export type Range = "1M" | "6M" | "1Y" | "All";

export const RANGES: readonly { value: Range; label: string }[] = [
  { value: "1M", label: "1M" },
  { value: "6M", label: "6M" },
  { value: "1Y", label: "1Y" },
  { value: "All", label: "All" },
];

const RANGE_MONTHS: Record<Exclude<Range, "All">, number> = { "1M": 1, "6M": 6, "1Y": 12 };
const RANGE_NAMES: Record<Range, string> = { "1M": "last month", "6M": "last 6 months", "1Y": "last year", All: "all time" };

const STALE_MS = 3 * 60 * 60 * 1000;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CHALK_WHITE = "#f1f1ec";

/** The points of a series from the start of the range up to today. */
export function inRange<T extends { date: string }>(points: T[], range: Range, today: string): T[] {
  if (range === "All") return points;
  const [year, month, day] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1 - RANGE_MONTHS[range], day)).toISOString().slice(0, 10);
  return points.filter((p) => p.date >= start);
}

export function rangeName(range: Range): string {
  return RANGE_NAMES[range];
}

/** "12 Sep" for "2026-09-12", or "12 Sep 2026" with the year. */
export function shortDate(date: string, withYear = false): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTH_NAMES[month - 1]}${withYear ? ` ${year}` : ""}`;
}

function clock(time: Date): string {
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** The time of the last price in the local time zone, for example "15:00". */
export function fetchedTime(lastFetchedAt: string): string {
  return clock(new Date(lastFetchedAt));
}

/** A note when the price is old or missing, or null when the price is current. */
export function priceNote(holding: PortfolioHolding, now: number = Date.now()): string | null {
  if (holding.failed) {
    return holding.closeDate ? `Price unavailable. Last close ${shortDate(holding.closeDate)}` : "Price unavailable";
  }
  if (holding.lastFetchedAt === null) return "No price yet";
  const fetched = new Date(holding.lastFetchedAt);
  if (now - fetched.getTime() <= STALE_MS) return null;
  const local = `${fetched.getFullYear()}-${fetched.getMonth() + 1}-${fetched.getDate()}`;
  return `Price from ${clock(fetched)}, ${shortDate(local)}`;
}

/** An amount in the quote currency of an asset, for example "$2,776.80". */
export function formatQuote(value: bigint, currency: string, locale?: string, signed = false): string {
  const text = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(Number(fromFixed(value)));
  return signed ? withPlus(text, value > 0n) : text;
}

/** An amount in the app currency. */
export function formatApp(value: bigint, currency: string, locale?: string, signed = false): string {
  return formatAmount(toMinor(value, minorUnits(currency)), currency, locale, { signed });
}

/** The profit as a share of the cost, for example "+27.8%". Null without a cost. */
export function profitPercent(profit: bigint | null, cost: bigint, locale?: string): string | null {
  if (profit === null || cost <= 0n) return null;
  const share = Number(profit) / Number(cost);
  const text = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(share);
  return withPlus(text, share >= 0.0005);
}

export function quantityText(holding: Pick<PortfolioHolding, "quantity" | "kind" | "symbol">): string {
  const quantity = fromFixed(holding.quantity);
  if (holding.kind === "crypto") return `${quantity} ${holding.symbol}`;
  return `${quantity} ${quantity === "1" ? "share" : "shares"}`;
}

export function profitColor(value: bigint | null, theme: ThemeColors): string {
  if (value === null || value === 0n) return theme.ink;
  return value > 0n ? theme.listGreen : theme.listRed;
}

type Props = {
  locale?: string;
  onOpen: (instrumentId: string) => void;
  onAdd: () => void;
};

/** The Portfolio page: net worth on the chalkboard, the value chart and the holdings. */
export function PortfolioScreen({ locale, onOpen, onAdd }: Props) {
  const { settings, theme } = useScreenSettings();
  const { data } = usePortfolio();
  const { data: accounts } = useAccountsTotal();
  const [range, setRange] = useState<Range>("1Y");
  const bottomInset = useBottomInset();

  if (!data) return null;
  const currency = settings?.currency_code ?? "EUR";

  if (data.holdings.length === 0) {
    return (
      <View style={[styles.screen, styles.empty, { backgroundColor: theme.row }]}>
        <Text allowFontScaling style={[styles.emptyTitle, { color: theme.ink }]}>
          No assets yet
        </Text>
        <Text allowFontScaling style={[styles.emptyText, { color: theme.accent }]}>
          Add a stock, an ETF or a coin. Then enter your trades, and the app tracks the price every hour.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add asset"
          onPress={onAdd}
          style={(state) => [styles.primary, { backgroundColor: theme.accent, opacity: state.pressed ? 0.75 : isHovered(state) ? 0.9 : 1 }]}
        >
          <Text allowFontScaling style={[styles.primaryText, { color: theme.paper }]}>
            Add asset
          </Text>
        </Pressable>
      </View>
    );
  }

  const { totals } = data;
  const accountsMinor = accounts?.total ?? 0;
  const portfolioMinor = toMinor(totals.value, minorUnits(currency));
  const app = (value: bigint, signed = false) => formatApp(value, currency, locale, signed);
  const percent = profitPercent(totals.openProfit, totals.cost, locale);
  const chalkText: TextStyle[] = [styles.chalkText, { fontFamily: summaryFontFamily(settings?.summary_font ?? "mono") }];
  const chalkColor = (value: bigint) => (value < 0n ? theme.chalkRed : value > 0n ? theme.chalkGreen : CHALK_WHITE);
  const today = localToday();
  const points = inRange(data.series, range, today).map((p) => ({ date: p.date, value: Number(fromFixed(p.value)) }));

  return (
    <View style={[styles.screen, { backgroundColor: theme.row }]}>
      <ScrollView testID="portfolio-scroll" style={styles.screen} contentContainerStyle={{ paddingBottom: bottomInset }}>
        <Texture kind="chalk" style={{ backgroundColor: theme.chalkBackground }}>
          <View testID="portfolio-board" style={styles.board}>
            <Text allowFontScaling style={[...chalkText, styles.boardLabel]}>
              Net worth
            </Text>
            <Text allowFontScaling style={[...chalkText, styles.boardBig]}>
              {formatAmount(accountsMinor + portfolioMinor, currency, locale)}
            </Text>
            <ChalkLine label="Accounts" amount={formatAmount(accountsMinor, currency, locale)} textStyle={chalkText} />
            <ChalkLine label="Portfolio" amount={app(totals.value)} textStyle={chalkText} />
            <ChalkLine
              label="Open profit"
              amount={`${app(totals.openProfit, true)}${percent ? ` (${percent})` : ""}`}
              textStyle={chalkText}
              color={chalkColor(totals.openProfit)}
            />
            <ChalkLine
              label="Realized profit"
              amount={app(totals.realized, true)}
              textStyle={chalkText}
              color={chalkColor(totals.realized)}
            />
            <View style={styles.boardChart}>
              <LineChart
                points={points}
                color={theme.chalkGreen}
                height={90}
                accessibilityLabel={`Portfolio value, ${rangeName(range)}`}
              />
            </View>
          </View>
        </Texture>

        <PaperBar theme={theme} style={styles.bar}>
          <SegmentedControl options={RANGES} value={range} onChange={setRange} theme={theme} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add asset"
            onPress={onAdd}
            hitSlop={8}
            style={(state) => [styles.add, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
          >
            <Text allowFontScaling style={[styles.addText, { color: theme.ink }]}>
              +
            </Text>
          </Pressable>
        </PaperBar>

        <Text allowFontScaling accessibilityRole="header" style={[styles.section, { color: theme.accent, borderBottomColor: theme.line }]}>
          Holdings
        </Text>
        {data.holdings.map((holding) => (
          <HoldingRow
            key={holding.instrumentId}
            holding={holding}
            currency={currency}
            locale={locale}
            note={priceNote(holding)}
            theme={theme}
            onPress={() => onOpen(holding.instrumentId)}
          />
        ))}
      </ScrollView>
      <Texture kind="paper" tint={paperTint(theme)} style={[styles.footer, { borderTopColor: theme.line }]}>
        <Text allowFontScaling style={[styles.footerText, { color: theme.accent }]}>
          {`Values in ${currency}. Rates from Yahoo Finance, updated every hour.`}
        </Text>
      </Texture>
    </View>
  );
}

function ChalkLine({ label, amount, textStyle, color }: { label: string; amount: string; textStyle: TextStyle[]; color?: string }) {
  return (
    <View style={styles.chalkLine}>
      <Text allowFontScaling style={[...textStyle, styles.chalkLineText]}>
        {label}
      </Text>
      <Text allowFontScaling style={[...textStyle, styles.chalkLineText, color ? { color } : null]}>
        {amount}
      </Text>
    </View>
  );
}

function HoldingRow({
  holding,
  currency,
  locale,
  note,
  theme,
  onPress,
}: {
  holding: PortfolioHolding;
  currency: string;
  locale?: string;
  note: string | null;
  theme: ThemeColors;
  onPress: () => void;
}) {
  const foreign = holding.quoteCurrency !== currency;
  const sub = [
    holding.symbol,
    holding.kind === "crypto" ? "" : holding.exchange,
    quantityText(holding),
    foreign && holding.value !== null ? formatQuote(holding.value, holding.quoteCurrency, locale) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const shown =
    holding.app.value !== null
      ? formatApp(holding.app.value, currency, locale)
      : holding.value !== null
        ? formatQuote(holding.value, holding.quoteCurrency, locale)
        : "–";
  const percent = profitPercent(holding.openProfit, holding.cost, locale);

  return (
    <Pressable
      testID={`holding-${holding.instrumentId}`}
      accessibilityRole="button"
      accessibilityLabel={`${holding.name}, ${shown}`}
      onPress={onPress}
      style={(state) => [
        styles.row,
        {
          backgroundColor: state.pressed ? theme.line : isHovered(state) ? theme.hover : theme.row,
          borderBottomColor: theme.line,
        },
      ]}
    >
      <View style={styles.rowMain}>
        <Text allowFontScaling numberOfLines={1} style={[styles.rowTitle, { color: theme.ink }]}>
          {holding.name}
        </Text>
        <Text allowFontScaling style={[styles.rowSub, { color: theme.accent }]}>
          {sub}
        </Text>
        {note ? (
          <Text allowFontScaling style={[styles.rowSub, styles.note, { color: theme.listRed }]}>
            {note}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowEnd}>
        <Text allowFontScaling style={[styles.rowAmount, { color: theme.ink }]}>
          {shown}
        </Text>
        {percent ? (
          <Text allowFontScaling style={[styles.rowSub, { color: profitColor(holding.openProfit, theme) }]}>
            {percent}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  board: {
    paddingTop: 14,
    paddingBottom: 12,
    paddingHorizontal: 22,
  },
  chalkText: {
    color: CHALK_WHITE,
    textShadowColor: "rgba(255, 255, 255, 0.35)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 1,
  },
  boardLabel: {
    fontSize: 14,
    letterSpacing: 0.5,
    textAlign: "center",
  },
  boardBig: {
    fontSize: 28,
    textAlign: "center",
    marginTop: 2,
    marginBottom: 10,
  },
  chalkLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  chalkLineText: {
    fontSize: 14.5,
  },
  boardChart: {
    marginTop: 12,
  },
  bar: {
    flexDirection: "row",
    padding: 12,
  },
  add: {
    position: "absolute",
    right: 14,
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  addText: {
    fontSize: 32,
    fontWeight: "200",
  },
  section: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 6,
    borderBottomWidth: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 50,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    gap: 12,
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 17,
  },
  rowSub: {
    fontSize: 12,
    marginTop: 2,
  },
  note: {
    fontStyle: "italic",
  },
  rowEnd: {
    alignItems: "flex-end",
  },
  rowAmount: {
    fontSize: 17,
  },
  footer: {
    paddingTop: 12,
    paddingBottom: 18,
    paddingHorizontal: 20,
    borderTopWidth: 1,
  },
  footerText: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  primary: {
    marginTop: 8,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 26,
    borderRadius: 4,
  },
  primaryText: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 1,
  },
});
