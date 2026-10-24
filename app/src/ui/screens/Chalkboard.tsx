import { useQuery } from "@powersync/react";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View, type TextStyle } from "react-native";

import {
  useBudgetProgress,
  useCarryOver,
  useCategoryBudgets,
  useShownCategoryTotals,
  useShownPeriodTotals,
  type CategoryBudget,
  type CategoryTotal,
} from "../../data/queries";
import { formatAmount, minorUnits } from "../../domain/money";
import type { Period } from "../../domain/period";
import type { UserSettings } from "../../generated/schema";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { isHovered } from "../components/interaction";
import { currencyName } from "../components/TransactionRow";
import { colors, resolveTheme, summaryFontFamily } from "../theme";
import { Texture } from "../Texture";

type AddType = "expense" | "income";

type Props = {
  period: Period;
  locale?: string;
  /** The hint below the buttons. Only the phone shows Reports in landscape. */
  showRotateHint?: boolean;
  /** accountId is null for All Accounts. */
  onCategoryPress: (categoryId: string, accountId: string | null) => void;
  onAdd: (type: AddType) => void;
};

const CHALK_WHITE = "#f1f1ec";

interface AccountOption {
  id: string;
  name: string;
}

/** Spoken amount with grouped thousands, for example "plus 92,434 euro 71". */
export function spokenAmount(minor: number, currency: string, signed = false): string {
  const scale = 10 ** minorUnits(currency);
  const abs = Math.abs(minor);
  const major = new Intl.NumberFormat("en").format(Math.floor(abs / scale));
  const rest = abs % scale;
  const sign = minor < 0 ? "minus " : signed && minor > 0 ? "plus " : "";
  return `${sign}${major} ${currencyName(currency)}${rest ? ` ${rest}` : ""}`;
}

/** The red part of the bar: expense of income, or spent of the budget. 0 to 1. */
function expenseShare(expense: number, base: number): number {
  if (base <= 0) return expense > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, expense / base));
}

type LineProps = {
  label: string;
  amount: string;
  textStyle: TextStyle[];
  amountColor?: string;
  size: "big" | "sub" | "balance";
};

function Line({ label, amount, textStyle, amountColor, size }: LineProps) {
  const sizeStyle = size === "big" ? styles.bigText : size === "balance" ? styles.balanceText : styles.subText;
  return (
    <View style={[styles.line, size === "sub" && styles.subLine]}>
      <Text allowFontScaling style={[...textStyle, sizeStyle]}>
        {label}
      </Text>
      <Text allowFontScaling style={[...textStyle, sizeStyle, amountColor ? { color: amountColor } : null]}>
        {amount}
      </Text>
    </View>
  );
}

/** The Spending summary on the chalk texture for the shared period. */
export function Chalkboard({ period, locale, showRotateHint = false, onCategoryPress, onAdd }: Props) {
  const scheme = useColorScheme();
  const { data: settingsRows } = useQuery<UserSettings>("SELECT * FROM user_settings LIMIT 1");
  const settings = settingsRows[0];
  const { data: accounts } = useQuery<AccountOption>(
    "SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY sort_order, name COLLATE NOCASE, id",
  );
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === chosenAccount) ?? null;
  const accountId = account?.id ?? null;

  // Without the pending deletes (Undo), as in the transaction list.
  const { data: totals } = useShownPeriodTotals(period, accountId);
  const { data: incomeCategories } = useShownCategoryTotals(period, accountId, "income");
  const { data: expenseCategories } = useShownCategoryTotals(period, accountId, "expense");
  const { data: carryRows } = useCarryOver(period.start, accountId === null ? null : [accountId]);
  const { data: budget } = useBudgetProgress(period);
  const { data: categoryBudgetRows } = useCategoryBudgets(period);
  const wide = useLayoutMode() === "sidebar";
  // Keep the first row of each category. The query orders by id, so a sync merge
  // that made two budget rows for one category resolves to the same row the form
  // and writeCategoryBudget edit (the lowest id).
  const budgetByCategory = new Map<string, CategoryBudget>();
  for (const b of categoryBudgetRows) if (!budgetByCategory.has(b.category_id)) budgetByCategory.set(b.category_id, b);

  const theme = colors[resolveTheme(settings?.theme ?? "system", scheme ?? "light")];
  const currency = settings?.currency_code ?? "EUR";
  const carryOverOn = Boolean(settings?.carry_over);
  const carryOver = carryOverOn ? carryRows.reduce((sum, row) => sum + row.balance, 0) : 0;
  const income = (totals?.income ?? 0) + carryOver;
  const expense = totals?.expense ?? 0;
  const balance = (totals?.balance ?? 0) + carryOver;
  const share = budget ? expenseShare(budget.spent_minor, budget.amount_minor) : expenseShare(expense, income);

  const chalkText: TextStyle[] = [
    styles.chalkText,
    { fontFamily: summaryFontFamily(settings?.summary_font ?? "mono") },
  ];
  const format = (minor: number, signed = false) => formatAmount(minor, currency, locale, { signed });
  const summary = [
    `Income ${spokenAmount(income, currency)}`,
    `expense ${spokenAmount(expense, currency)}`,
    `balance ${spokenAmount(balance, currency, true)}`,
  ].join(", ");

  const options: (string | null)[] = [null, ...accounts.map((a) => a.id)];
  const cycle = (step: number) => {
    const index = options.indexOf(accountId);
    setChosenAccount(options[(index + step + options.length) % options.length]);
  };

  const categoryLine = (row: CategoryTotal, testID: string, categoryBudget?: CategoryBudget): ReactNode => {
    // The bar uses row.total, not the query's spent_minor, so it matches the line
    // amount while a pending Undo delete hides a transaction. Both cover the same
    // rows (expense, this category, the period, Hide Future, all accounts).
    const spent = row.total;
    const over = categoryBudget ? spent > categoryBudget.amount_minor : false;
    const rest = categoryBudget ? Math.abs(categoryBudget.amount_minor - spent) : 0;
    const fillShare = categoryBudget
      ? Math.min(1, categoryBudget.amount_minor > 0 ? spent / categoryBudget.amount_minor : 1)
      : 0;
    const amountText =
      categoryBudget && wide ? `${format(row.total)} / ${format(categoryBudget.amount_minor)}` : format(row.total);
    const label = categoryBudget
      ? `${row.name}, ${spokenAmount(row.total, currency)}, budget ${spokenAmount(categoryBudget.amount_minor, currency)}`
      : `${row.name}, ${spokenAmount(row.total, currency)}`;
    return (
      <Pressable
        key={row.category_id}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => onCategoryPress(row.category_id, accountId)}
        style={(state) => [styles.categoryLine, (isHovered(state) || state.pressed) && styles.chalkHover]}
      >
        <Line label={row.name} amount={amountText} textStyle={chalkText} size="sub" />
        {categoryBudget ? (
          <>
            {wide ? null : (
              <Text allowFontScaling style={[...chalkText, styles.budgetText, over ? { color: theme.chalkRed } : null]}>
                {over
                  ? `of ${format(categoryBudget.amount_minor)} · ${format(rest)} over`
                  : `of ${format(categoryBudget.amount_minor)} · ${format(rest)} left`}
              </Text>
            )}
            <View testID="category-budget-bar" style={styles.budgetBar}>
              <View
                testID="category-budget-fill"
                style={[styles.budgetFill, { width: `${fillShare * 100}%`, backgroundColor: theme.chalkRed }]}
              />
            </View>
          </>
        ) : null}
      </Pressable>
    );
  };

  return (
    <Texture kind="chalk" style={[styles.board, { backgroundColor: theme.chalkBackground }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.picker}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous account" hitSlop={12} onPress={() => cycle(-1)}>
            <Text style={[...chalkText, styles.arrow]}>‹</Text>
          </Pressable>
          <Text allowFontScaling numberOfLines={1} ellipsizeMode="tail" style={[...chalkText, styles.pickerText]}>
            {account?.name ?? "All Accounts"}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Next account" hitSlop={12} onPress={() => cycle(1)}>
            <Text style={[...chalkText, styles.arrow]}>›</Text>
          </Pressable>
        </View>

        <View testID="chalkboard-summary" accessible accessibilityRole="summary" accessibilityLabel={summary}>
          <View style={[styles.bar, { backgroundColor: theme.chalkGreen, borderColor: CHALK_WHITE }]}>
            <View testID="expense-share" style={[styles.barRed, { width: `${share * 100}%`, backgroundColor: theme.chalkRed }]} />
          </View>
        </View>

        <Line label="Income" amount={format(income)} textStyle={chalkText} amountColor={theme.chalkGreen} size="big" />
        {carryOverOn ? <Line label="Carry Over" amount={format(carryOver, true)} textStyle={chalkText} size="sub" /> : null}
        {incomeCategories.map((row) => categoryLine(row, "income-category"))}
        {account ? (
          <Line label="Transfer in" amount={format(totals?.transfer_in ?? 0)} textStyle={chalkText} size="sub" />
        ) : null}

        <Line label="Expense" amount={format(expense)} textStyle={chalkText} amountColor={theme.chalkRed} size="big" />
        {expenseCategories.map((row) =>
          categoryLine(row, "expense-category", account ? undefined : budgetByCategory.get(row.category_id)),
        )}
        {account ? (
          <Line label="Transfer out" amount={format(totals?.transfer_out ?? 0)} textStyle={chalkText} size="sub" />
        ) : null}

        <View testID="balance-divider" style={[styles.divider, { borderColor: CHALK_WHITE }]} />
        <Line label="Balance" amount={format(balance, true)} textStyle={chalkText} amountColor={theme.chalkBlue} size="balance" />

        <View style={styles.buttons}>
          {(["expense", "income"] as const).map((type) => {
            const label = type === "expense" ? "+ Expense" : "+ Income";
            return (
              <Pressable
                key={type}
                testID={`add-${type}`}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => onAdd(type)}
                style={(state) => [styles.button, { borderColor: CHALK_WHITE }, (isHovered(state) || state.pressed) && styles.chalkHover]}
              >
                <Text allowFontScaling style={[...chalkText, styles.buttonText]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {showRotateHint ? (
          <Text allowFontScaling style={[...chalkText, styles.hint]}>
            ** Rotate device to view reports **
          </Text>
        ) : null}
      </ScrollView>
    </Texture>
  );
}

const styles = StyleSheet.create({
  board: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingTop: 12,
    paddingBottom: 10,
    paddingHorizontal: 22,
  },
  chalkText: {
    color: CHALK_WHITE,
    textShadowColor: "rgba(255, 255, 255, 0.35)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 1,
  },
  picker: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 40,
    marginBottom: 10,
    // A long account name shrinks, so the arrows keep clear of the screen edges.
    paddingHorizontal: 32,
  },
  pickerText: {
    flexShrink: 1,
    textAlign: "center",
    fontSize: 14,
    letterSpacing: 0.5,
  },
  arrow: {
    fontSize: 22,
  },
  bar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    height: 10,
    borderRadius: 6,
    borderWidth: 1.5,
    overflow: "hidden",
    marginBottom: 16,
  },
  barRed: {
    height: "100%",
  },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  subLine: {
    paddingLeft: 18,
  },
  subText: {
    fontSize: 13.5,
  },
  bigText: {
    fontSize: 19,
  },
  balanceText: {
    fontSize: 23,
  },
  divider: {
    borderTopWidth: 2,
    borderStyle: "dashed",
    opacity: 0.8,
    marginTop: 12,
    marginBottom: 6,
  },
  categoryLine: {
    marginHorizontal: -6,
    paddingHorizontal: 6,
    borderRadius: 4,
  },
  budgetText: {
    fontSize: 11,
    paddingLeft: 18,
  },
  budgetBar: {
    height: 5,
    borderWidth: 1,
    borderColor: `${CHALK_WHITE}b3`,
    borderRadius: 4,
    marginLeft: 18,
    marginTop: 2,
    marginBottom: 4,
    overflow: "hidden",
  },
  budgetFill: {
    height: "100%",
  },
  chalkHover: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  buttons: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 28,
    marginTop: "auto",
    paddingTop: 16,
  },
  button: {
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  buttonText: {
    fontSize: 15,
  },
  hint: {
    textAlign: "center",
    fontSize: 11,
    opacity: 0.6,
    marginTop: 10,
  },
});
