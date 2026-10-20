import { useQuery } from "@powersync/react";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View, type StyleProp, type ViewStyle } from "react-native";

import { useCashFlowSeries, useCategoryTotals } from "../../data/queries";
import { formatAmount } from "../../domain/money";
import { periodLabel, today as localToday, type Period, type PeriodKind, type PeriodSettings } from "../../domain/period";
import type { UserSettings } from "../../generated/schema";
import type { LayoutMode } from "../../hooks/useLayoutMode";
import { CashFlowChart } from "../charts/CashFlowChart";
import { PieChart, percent, type PieSlice } from "../charts/PieChart";
import { isHovered } from "../components/interaction";
import { SegmentedControl } from "../components/SegmentedControl";
import { colors, resolveTheme } from "../theme";
import { spokenAmount } from "./Chalkboard";

type Tab = "categories" | "cashFlow";

const TABS: { value: Tab; label: string }[] = [
  { value: "categories", label: "Categories" },
  { value: "cashFlow", label: "Cash Flow" },
];

const CASH_FLOW_PERIODS = 8;
const SUMMARY_TOP = 5;
const LANDSCAPE_TEXT = "#f1f1ec";

/** In phone landscape, Reports takes the place of these pages. */
const LANDSCAPE_PAGES = ["spending", "transactions"];

export function reportsReplacesPage(mode: LayoutMode, routeName: string): boolean {
  return mode === "phoneLandscape" && LANDSCAPE_PAGES.includes(routeName);
}

type Props = {
  period: Period;
  kind: PeriodKind;
  settings: PeriodSettings;
  locale?: string;
  today?: string;
  /** "landscape" is the full screen phone view on a dark background. */
  variant?: "page" | "landscape";
  /** Shows ◀ ▶ and the period label. The browser sidebar page header has its own. */
  showPeriodNav?: boolean;
  /** Extra root style, for example safe area padding. */
  style?: StyleProp<ViewStyle>;
  onShift: (step: number) => void;
  onCategoryPress: (categoryId: string) => void;
};

/** The Categories pie and the Cash Flow lines for the shared period. */
export function Reports({
  period,
  kind,
  settings,
  locale,
  today = localToday(),
  variant = "page",
  showPeriodNav = true,
  style,
  onShift,
  onCategoryPress,
}: Props) {
  const scheme = useColorScheme();
  const [tab, setTab] = useState<Tab>("categories");
  const { data: settingsRows } = useQuery<UserSettings>("SELECT * FROM user_settings LIMIT 1");
  const userSettings = settingsRows[0];
  const { data: categories } = useCategoryTotals(period, null, "expense");
  const { data: series } = useCashFlowSeries(period, kind, settings, CASH_FLOW_PERIODS);

  const theme = colors[resolveTheme(userSettings?.theme ?? "system", scheme ?? "light")];
  const landscape = variant === "landscape";
  const background = landscape ? theme.chalkBackground : theme.row;
  const text = landscape ? LANDSCAPE_TEXT : theme.ink;
  const currency = userSettings?.currency_code ?? "EUR";
  const format = (minor: number) => formatAmount(minor, currency, locale);
  const spoken = (minor: number) => spokenAmount(minor, currency);

  const total = categories.reduce((sum, row) => sum + row.total, 0);
  const slices: PieSlice[] = categories.map((row) => ({
    id: row.category_id,
    label: row.name,
    value: row.total,
    color: row.color,
  }));
  const top = slices.slice(0, SUMMARY_TOP).map((s) => `${s.label} ${percent(s.value, total)}%`);
  const othersValue = slices.slice(SUMMARY_TOP).reduce((sum, s) => sum + s.value, 0);
  if (slices.length > SUMMARY_TOP) top.push(`others ${percent(othersValue, total)}%`);
  const summary = `Top categories: ${top.join(", ")}.`;

  const points = series.map((p) => ({
    label: periodLabel({ start: p.start, end: p.end }, kind, locale, today),
    income: p.income,
    expense: p.expense,
  }));

  const pie = (
    <View style={[styles.pieArea, landscape && styles.pieAreaLandscape]}>
      <PieChart slices={slices} labelColor="#ffffff" onSlicePress={onCategoryPress} />
      <View style={styles.legend}>
        {slices.map((slice) => {
          const share = percent(slice.value, total);
          return (
            <Pressable
              key={slice.id}
              testID="pie-legend-item"
              accessibilityRole="button"
              accessibilityLabel={`${slice.label}, ${spoken(slice.value)}, ${share}%`}
              onPress={() => onCategoryPress(slice.id)}
              style={(state) => [
                styles.legendItem,
                (isHovered(state) || state.pressed) && { backgroundColor: landscape ? "rgba(255, 255, 255, 0.08)" : theme.hover },
              ]}
            >
              <View style={[styles.swatch, { backgroundColor: slice.color }]} />
              <Text allowFontScaling numberOfLines={1} style={[styles.legendName, { color: text }]}>
                {slice.label}
              </Text>
              <Text allowFontScaling style={[styles.legendAmount, { color: text }]}>
                {format(slice.value)}
              </Text>
            </Pressable>
          );
        })}
        <Text testID="pie-summary" allowFontScaling style={[styles.summary, { color: text }]}>
          {summary}
        </Text>
      </View>
    </View>
  );

  return (
    <View testID="reports" style={[styles.screen, { backgroundColor: background }, style]}>
      <View style={styles.header}>
        {showPeriodNav && (
          <View style={styles.periodNav}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous period" hitSlop={10} onPress={() => onShift(-1)}>
              <Text style={[styles.arrow, { color: text }]}>◀</Text>
            </Pressable>
            <Text allowFontScaling style={[styles.periodText, { color: text }]}>
              {periodLabel(period, kind, locale, today)}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Next period" hitSlop={10} onPress={() => onShift(1)}>
              <Text style={[styles.arrow, { color: text }]}>▶</Text>
            </Pressable>
          </View>
        )}
        <SegmentedControl options={TABS} value={tab} onChange={setTab} theme={theme} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {tab === "categories" ? (
          slices.length > 0 ? (
            pie
          ) : (
            <Text allowFontScaling style={[styles.empty, { color: text }]}>
              No expenses in this period
            </Text>
          )
        ) : (
          <CashFlowChart
            points={points}
            colors={{
              income: landscape ? theme.chalkGreen : theme.listGreen,
              expense: landscape ? theme.chalkRed : theme.listRed,
              text,
              grid: landscape ? "#555555" : theme.line,
              pill: background,
            }}
            formatAmount={format}
            spokenAmount={spoken}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    alignItems: "center",
    gap: 10,
    paddingTop: 12,
    paddingHorizontal: 16,
  },
  periodNav: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
  },
  arrow: {
    fontSize: 16,
  },
  periodText: {
    fontSize: 16,
  },
  content: {
    flexGrow: 1,
    padding: 16,
    paddingTop: 24,
  },
  pieArea: {
    alignItems: "center",
    gap: 16,
  },
  pieAreaLandscape: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: 28,
  },
  legend: {
    alignSelf: "stretch",
    flexShrink: 1,
    gap: 2,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  legendName: {
    flex: 1,
    fontSize: 14,
  },
  legendAmount: {
    fontSize: 14,
  },
  summary: {
    fontSize: 12,
    marginTop: 8,
    paddingHorizontal: 10,
    opacity: 0.8,
  },
  empty: {
    textAlign: "center",
    fontSize: 15,
    marginTop: 40,
  },
});
