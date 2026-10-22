import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import type { TransactionListRow } from "../../data/queries";
import { formatAmount, minorUnits } from "../../domain/money";
import { CategoryIcon, categoryIcons, type CategoryIconKey, type IconVariant } from "../icons/categoryIcons";
import { TransferIcon } from "../icons/transferIcon";
import { colors, type ThemeColors } from "../theme";
import { isHovered } from "./interaction";

type Props = {
  row: TransactionListRow;
  iconStyle?: IconVariant;
  locale?: string;
  onPress?: () => void;
  /** UserSettings.show_note: a line with the note under the subtitle. */
  showNote?: boolean;
  theme?: ThemeColors;
};

const ICON_SIZE = 30;

function formatRowDate(date: string, locale?: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(utc);
  const rest = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(utc);
  return `${weekday}, ${rest}`;
}

export function currencyName(code: string): string {
  try {
    return (new Intl.DisplayNames("en", { type: "currency" }).of(code) ?? code).toLowerCase();
  } catch {
    return code;
  }
}

/** Spoken amount, for example "expense 14 euro 99" or "carry over minus 5 euro". */
export function amountAccessibilityLabel(row: Pick<TransactionListRow, "kind" | "type" | "amount_minor" | "currency_code">): string {
  const kind = row.kind === "carryOver" ? "carry over" : row.type;
  const scale = 10 ** minorUnits(row.currency_code);
  const abs = Math.abs(row.amount_minor);
  const major = Math.floor(abs / scale);
  const minor = abs % scale;
  const sign = row.amount_minor < 0 ? "minus " : "";
  return `${kind} ${sign}${major} ${currencyName(row.currency_code)}${minor ? ` ${minor}` : ""}`;
}

function amountColor(row: TransactionListRow, theme: ThemeColors): string {
  if (row.kind === "carryOver") return row.amount_minor < 0 ? theme.listRed : theme.listGreen;
  if (row.type === "expense") return theme.listRed;
  if (row.type === "income") return theme.listGreen;
  return theme.ink;
}

const TYPE_LABELS: Record<TransactionListRow["type"], string> = { expense: "Expense", income: "Income", transfer: "Transfer" };

/** The name, or for a transaction without a name: the category, "Transfer" or the type. */
function rowTitle(row: TransactionListRow): string {
  if (row.name.trim() !== "") return row.name;
  if (row.type === "transfer") return TYPE_LABELS.transfer;
  return row.category_name || TYPE_LABELS[row.type];
}

function iconKey(row: TransactionListRow): CategoryIconKey | null {
  if (row.kind === "carryOver") return "piggy";
  if (row.category_icon && row.category_icon in categoryIcons) return row.category_icon as CategoryIconKey;
  return null;
}

function RepeatMark({ color }: { color: string }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" testID="repeat-mark">
      <Path d="M20 12a8 8 0 0 1-14 5M4 12a8 8 0 0 1 14-5M18 3v4h-4M6 21v-4h4" fill="none" stroke={color} strokeWidth={2} />
    </Svg>
  );
}

export function TransactionRow({ row: listRow, iconStyle = "filled", locale, onPress, showNote = false, theme = colors.light }: Props) {
  const carryOver = listRow.kind === "carryOver";
  // transactionList gives a Carry Over as the absolute balance, with type "expense" when the balance is negative.
  const row =
    carryOver && listRow.type === "expense" && listRow.amount_minor > 0
      ? { ...listRow, amount_minor: -listRow.amount_minor }
      : listRow;
  const background = carryOver ? theme.carryOver : theme.row;
  const account = row.type === "transfer" ? `${row.account_name ?? ""} → ${row.to_account_name ?? ""}` : (row.account_name ?? "");
  const subtitle = `${account}, ${formatRowDate(row.date, locale)}`;
  const amount = formatAmount(row.amount_minor, row.currency_code, locale);
  const recurring = row.recurring_rule_id !== null;
  const icon = iconKey(row);
  const title = rowTitle(row);
  const note = showNote && !carryOver ? row.note?.trim() || null : null;
  const label = [title, amountAccessibilityLabel(row), subtitle, recurring ? "repeats" : null, note]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      testID="transaction-row"
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      onPress={onPress}
      disabled={!onPress}
      style={(state) => [
        styles.row,
        {
          backgroundColor: onPress && state.pressed ? theme.line : onPress && isHovered(state) ? theme.hover : background,
          borderBottomColor: theme.line,
        },
      ]}
    >
      <View style={styles.icon}>
        {icon ? (
          <CategoryIcon
            icon={icon}
            variant={iconStyle}
            size={ICON_SIZE}
            color={theme.ink}
            background={background}
          />
        ) : row.type === "transfer" && !carryOver ? (
          <TransferIcon size={ICON_SIZE} color={theme.ink} />
        ) : null}
      </View>
      <View style={styles.body}>
        <Text allowFontScaling numberOfLines={2} style={[styles.name, { color: theme.ink }]}>
          {title}
        </Text>
        <View style={styles.subtitleLine}>
          <Text allowFontScaling numberOfLines={1} style={[styles.subtitle, { color: theme.accent }]}>
            {subtitle}
          </Text>
          {recurring ? (
            <View style={styles.repeat}>
              <RepeatMark color={theme.accent} />
            </View>
          ) : null}
        </View>
        {note ? (
          <Text testID="transaction-note-line" allowFontScaling numberOfLines={1} style={[styles.note, { color: theme.accent }]}>
            {note}
          </Text>
        ) : null}
      </View>
      <Text allowFontScaling style={[styles.amount, { color: amountColor(row, theme) }]}>
        {amount}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingLeft: 10,
    paddingRight: 12,
    borderBottomWidth: 1,
  },
  icon: {
    width: ICON_SIZE,
    marginRight: 12,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 19,
  },
  subtitleLine: {
    flexDirection: "row",
    alignItems: "center",
  },
  subtitle: {
    flexShrink: 1,
    fontSize: 11,
  },
  note: {
    fontSize: 11,
    fontStyle: "italic",
    marginTop: 1,
  },
  repeat: {
    marginLeft: 4,
  },
  amount: {
    fontSize: 19,
    marginLeft: 6,
  },
});
