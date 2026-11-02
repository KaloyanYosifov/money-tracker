import { useContext, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { useInstrument, type TradeRow } from "../../data/portfolio";
import { fromFixed, toFixed } from "../../domain/decimal";
import { today as localToday } from "../../domain/period";
import { LineChart } from "../charts/LineChart";
import { isHovered } from "../components/interaction";
import { SegmentedControl } from "../components/SegmentedControl";
import { useBottomInset } from "../nav/bottomInset";
import type { ThemeColors } from "../theme";
import { useScreenSettings } from "./manage";
import {
  fetchedTime,
  formatApp,
  formatQuote,
  inRange,
  priceNote,
  profitColor,
  profitPercent,
  rangeName,
  RANGES,
  shortDate,
  type Range,
} from "./Portfolio";

type Props = {
  id: string;
  locale?: string;
  onBack: () => void;
  onAddTrade: () => void;
  onOpenTrade: (tradeId: string) => void;
};

/** One asset: the price chart, the holding and its trades. */
export function InstrumentDetailScreen({ id, locale, onBack, onAddTrade, onOpenTrade }: Props) {
  const { settings, theme } = useScreenSettings();
  const { data } = useInstrument(id);
  const [range, setRange] = useState<Range>("1Y");
  const bottomInset = useBottomInset();
  // On iOS the screen fills the display, so the header starts below the status bar.
  const top = useContext(SafeAreaInsetsContext)?.top ?? 0;

  const header = (
    <View style={[styles.header, { borderBottomColor: theme.line, paddingTop: top }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={onBack}
        hitSlop={8}
        style={(state) => [styles.headerButton, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
      >
        <Text allowFontScaling style={[styles.backText, { color: theme.ink }]}>
          ‹ Portfolio
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add trade"
        onPress={onAddTrade}
        hitSlop={8}
        style={(state) => [styles.headerButton, styles.add, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
      >
        <Text allowFontScaling style={[styles.addText, { color: theme.ink }]}>
          +
        </Text>
      </Pressable>
    </View>
  );

  if (!data) {
    return <View style={[styles.screen, { backgroundColor: theme.paper }]}>{header}</View>;
  }

  const { instrument, holding, trades } = data;
  const appCurrency = settings?.currency_code ?? "EUR";
  const quote = holding.quoteCurrency;
  const foreign = quote !== appCurrency;
  const q = (value: bigint, signed = false) => formatQuote(value, quote, locale, signed);
  const app = (value: bigint | null, signed = false) =>
    foreign && value !== null ? formatApp(value, appCurrency, locale, signed) : undefined;
  const note = priceNote(holding);
  const sub = [
    holding.symbol,
    holding.exchange,
    holding.close !== null ? q(holding.close) : "",
    note ?? (holding.lastFetchedAt ? `updated ${fetchedTime(holding.lastFetchedAt)}` : ""),
  ]
    .filter(Boolean)
    .join(" · ");
  const points = inRange(holding.prices, range, localToday()).map((p) => ({ date: p.date, value: Number(fromFixed(p.close)) }));
  const percent = profitPercent(holding.openProfit, holding.cost, locale);

  return (
    <View style={[styles.screen, { backgroundColor: theme.paper }]}>
      {header}
      <ScrollView contentContainerStyle={{ paddingBottom: 24 + bottomInset }}>
        <View style={[styles.card, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
          <View style={styles.titleRow}>
            <Text allowFontScaling accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>
              {instrument.name}
            </Text>
            <Text allowFontScaling style={[styles.badge, { color: theme.accent, borderColor: theme.accent }]}>
              {quote}
            </Text>
          </View>
          <Text allowFontScaling style={[styles.sub, { color: holding.failed ? theme.listRed : theme.accent }]}>
            {sub}
          </Text>
        </View>

        <View style={styles.range}>
          <SegmentedControl options={RANGES} value={range} onChange={setRange} theme={theme} />
        </View>
        <View style={styles.chart}>
          <LineChart
            points={points}
            color={theme.accent}
            height={140}
            accessibilityLabel={`${holding.symbol} price, ${rangeName(range)}`}
          />
        </View>

        <View style={styles.stats}>
          <Stat label="Open quantity" value={fromFixed(holding.quantity)} theme={theme} />
          <Stat
            label="Value"
            value={holding.value !== null ? q(holding.value) : "–"}
            sub={app(holding.app.value)}
            theme={theme}
          />
          <Stat label="Cost of open lots (FIFO)" value={q(holding.cost)} theme={theme} />
          <Stat
            label="Open profit"
            value={holding.openProfit !== null ? q(holding.openProfit, true) : "–"}
            color={profitColor(holding.openProfit, theme)}
            sub={percent ?? undefined}
            subColor={profitColor(holding.openProfit, theme)}
            theme={theme}
          />
          <Stat
            label="Realized profit"
            value={q(holding.realized, true)}
            color={profitColor(holding.realized, theme)}
            sub={app(holding.app.realized, true)}
            theme={theme}
          />
          <Stat label="Fees paid" value={q(holding.fees)} theme={theme} />
        </View>

        <Text allowFontScaling accessibilityRole="header" style={[styles.section, { color: theme.accent, borderBottomColor: theme.line }]}>
          Trades
        </Text>
        <View style={[styles.tradeRow, { backgroundColor: theme.paper, borderBottomColor: theme.line }]}>
          <Cell text="Date" theme={theme} head />
          <Cell text="Side" theme={theme} head />
          <Cell text="Qty" theme={theme} head numeric />
          <Cell text="Price" theme={theme} head numeric />
        </View>
        {trades.map((trade) => (
          <TradeLine key={trade.id} trade={trade} currency={quote} locale={locale} theme={theme} onPress={() => onOpenTrade(trade.id)} />
        ))}
      </ScrollView>
    </View>
  );
}

function Stat({
  label,
  value,
  color,
  sub,
  subColor,
  theme,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
  subColor?: string;
  theme: ThemeColors;
}) {
  return (
    <View testID={`stat-${label}`} style={[styles.stat, { backgroundColor: theme.row, borderColor: theme.line }]}>
      <Text allowFontScaling style={[styles.statLabel, { color: theme.accent }]}>
        {label}
      </Text>
      <Text allowFontScaling style={[styles.statValue, { color: color ?? theme.ink }]}>
        {value}
      </Text>
      {sub ? (
        <Text allowFontScaling style={[styles.sub, { color: subColor ?? theme.accent }]}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function Cell({
  text,
  theme,
  color,
  head = false,
  numeric = false,
}: {
  text: ReactNode;
  theme: ThemeColors;
  color?: string;
  head?: boolean;
  numeric?: boolean;
}) {
  return (
    <Text
      allowFontScaling
      style={[styles.cell, head && styles.headCell, numeric && styles.numeric, { color: color ?? (head ? theme.accent : theme.ink) }]}
    >
      {text}
    </Text>
  );
}

function TradeLine({
  trade,
  currency,
  locale,
  theme,
  onPress,
}: {
  trade: TradeRow;
  currency: string;
  locale?: string;
  theme: ThemeColors;
  onPress: () => void;
}) {
  const sell = trade.side === "sell";
  const date = shortDate(trade.date, true);
  const quantity = fromFixed(toFixed(trade.quantity) ?? 0n);
  const price = formatQuote(toFixed(trade.price) ?? 0n, currency, locale);
  return (
    <Pressable
      testID={`trade-${trade.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${sell ? "Sell" : "Buy"} ${quantity} at ${price}, ${date}`}
      onPress={onPress}
      style={(state) => [
        styles.tradeRow,
        {
          backgroundColor: state.pressed ? theme.line : isHovered(state) ? theme.hover : theme.row,
          borderBottomColor: theme.line,
        },
      ]}
    >
      <Cell text={date} theme={theme} />
      <Cell text={sell ? "Sell" : "Buy"} color={sell ? theme.listRed : theme.listGreen} theme={theme} />
      <Cell text={quantity} theme={theme} numeric />
      <Cell text={price} theme={theme} numeric />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 58,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  headerButton: {
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: 22,
    justifyContent: "center",
  },
  backText: {
    fontSize: 18,
  },
  add: {
    minWidth: 44,
    alignItems: "center",
  },
  addText: {
    fontSize: 32,
    fontWeight: "200",
  },
  card: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    flexShrink: 1,
    fontSize: 20,
  },
  badge: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  sub: {
    fontSize: 12,
    marginTop: 2,
  },
  range: {
    paddingTop: 14,
    paddingBottom: 8,
  },
  chart: {
    paddingHorizontal: 14,
  },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    padding: 14,
  },
  stat: {
    flexBasis: "47%",
    flexGrow: 1,
    padding: 10,
    borderWidth: 1,
    borderRadius: 6,
  },
  statLabel: {
    fontSize: 12,
  },
  statValue: {
    fontSize: 18,
    marginTop: 2,
  },
  section: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 6,
  },
  tradeRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  cell: {
    flex: 1,
    fontSize: 15,
  },
  headCell: {
    fontSize: 12,
    fontWeight: "600",
  },
  numeric: {
    textAlign: "right",
  },
});
