import { useQuery } from "@powersync/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  type GestureResponderEvent,
  type KeyDownEvent,
  type TextInputInstance,
} from "react-native";
import Svg, { Path } from "react-native-svg";

import { UNDO_DELAY_MS, useUndo } from "../../data/UndoProvider";
import {
  useCarryOver,
  usePeriodTotals,
  useTransactionList,
  type TransactionListRow,
  type TransactionSort,
} from "../../data/queries";
import { formatAmount } from "../../domain/money";
import type { Period } from "../../domain/period";
import type { Transaction, UserSettings } from "../../generated/schema";
import { useShortcuts } from "../../hooks/useShortcuts";
import { isHovered } from "../components/interaction";
import { PaperBar } from "../components/PaperBar";
import { TransactionRow } from "../components/TransactionRow";
import { UndoToast } from "../components/UndoToast";
import { colors, resolveTheme, type ThemeColors } from "../theme";

type Layout = "web" | "phone";

type Props = {
  period: Period;
  locale?: string;
  /** "web" shows search, Sort, Filter and Export in the paper bar. "phone" shows the bottom toolbar. */
  layout: Layout;
  initialAccountId?: string | null;
  initialCategoryId?: string | null;
  /** Opens the transaction form. */
  onOpen: (id: string) => void;
  /** Moves to the previous (-1) or the next (+1) period. */
  onShift: (step: number) => void;
};

export const SEARCH_DEBOUNCE_MS = 200;
const SWIPE_DISTANCE = 60;
const SWIPE_START = 10;

interface AccountOption {
  id: string;
  name: string;
}

interface MenuOption {
  value: string;
  label: string;
  selected: boolean;
}

type MenuKind = "account" | "filter" | "sort";

const TYPE_LABELS: Record<Transaction["type"], string> = { expense: "Expense", income: "Income", transfer: "Transfer" };
const SORT_LABELS: Record<TransactionSort, string> = { date: "Date", name: "Name", amount: "Amount" };

function OptionMenu({
  title,
  options,
  onSelect,
  onClose,
  theme,
}: {
  title: string;
  options: MenuOption[];
  onSelect: (value: string) => void;
  onClose: () => void;
  theme: ThemeColors;
}) {
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close menu" style={styles.backdrop} onPress={onClose}>
        <View accessibilityRole="menu" style={[styles.menu, { backgroundColor: theme.row, borderColor: theme.line }]}>
          <Text allowFontScaling style={[styles.menuTitle, { color: theme.accent }]}>
            {title}
          </Text>
          {options.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="menuitem"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: option.selected }}
              onPress={() => onSelect(option.value)}
              style={[styles.menuItem, { borderTopColor: theme.line }]}
            >
              <Text allowFontScaling style={[styles.menuText, { color: theme.ink }]}>
                {option.label}
              </Text>
              {option.selected ? <Text style={[styles.menuText, { color: theme.accent }]}>✓</Text> : null}
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

type RowProps = {
  row: TransactionListRow;
  layout: Layout;
  locale?: string;
  iconStyle: "filled" | "outline";
  theme: ThemeColors;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
};

/** A list row. Swipe left (phone) or the Delete key (web) deletes it. Carry Over rows only show. */
function ListItem({ row, layout, locale, iconStyle, theme, onOpen, onDelete }: RowProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const editable = row.kind === "transaction";

  const offset = (event: GestureResponderEvent) => {
    if (!start.current) return null;
    return { dx: event.nativeEvent.pageX - start.current.x, dy: event.nativeEvent.pageY - start.current.y };
  };

  const deleteHandlers = !editable
    ? {}
    : layout === "web"
      ? {
          onKeyDown: (event: KeyDownEvent) => {
            const key = event.nativeEvent.key;
            if (key === "Delete" || key === "Backspace") onDelete(row.id);
          },
        }
      : {
          onTouchStart: (event: GestureResponderEvent) => {
            start.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
          },
          onMoveShouldSetResponder: (event: GestureResponderEvent) => {
            const move = offset(event);
            return move !== null && move.dx < -SWIPE_START && Math.abs(move.dx) > Math.abs(move.dy);
          },
          onResponderRelease: (event: GestureResponderEvent) => {
            const move = offset(event);
            start.current = null;
            if (move && move.dx <= -SWIPE_DISTANCE && Math.abs(move.dx) > Math.abs(move.dy)) onDelete(row.id);
          },
          onResponderTerminate: () => {
            start.current = null;
          },
        };

  return (
    <View testID={`row-${row.id}`} {...deleteHandlers}>
      <TransactionRow
        row={row}
        iconStyle={iconStyle}
        locale={locale}
        theme={theme}
        onPress={editable ? () => onOpen(row.id) : undefined}
      />
    </View>
  );
}

function ToolbarButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress}>
      {children}
    </Pressable>
  );
}

function BarButton({ label, onPress, theme }: { label: string; onPress: () => void; theme: ThemeColors }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={(state) => [styles.barButton, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
    >
      <Text allowFontScaling style={[styles.barAction, { color: theme.accent }]}>
        {`${label} ▾`}
      </Text>
    </Pressable>
  );
}

function ToolbarIcon({ d, color, filled = false, size = 24 }: { d: string; color: string; filled?: boolean; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={d}
        fill={filled ? color : "none"}
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The Transactions page: paper bar, totals bar and the list of the shared period. */
export function TransactionList({
  period,
  locale,
  layout,
  initialAccountId = null,
  initialCategoryId = null,
  onOpen,
  onShift,
}: Props) {
  const scheme = useColorScheme();
  const { hiddenIds, requestDelete, undo } = useUndo();
  const { data: settingsRows } = useQuery<UserSettings>("SELECT * FROM user_settings LIMIT 1");
  const settings = settingsRows[0];
  const { data: accounts } = useQuery<AccountOption>(
    "SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY sort_order, name COLLATE NOCASE, id",
  );

  const [accountId, setAccountId] = useState<string | null>(initialAccountId);
  const [categoryId, setCategoryId] = useState<string | null>(initialCategoryId);
  const [type, setType] = useState<Transaction["type"] | null>(null);
  const [sort, setSort] = useState<TransactionSort>("date");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInput = useRef<TextInputInstance>(null);

  const { data: categoryRows } = useQuery<{ name: string }>("SELECT name FROM categories WHERE id = ?", [categoryId]);
  const categoryName = categoryId ? (categoryRows[0]?.name ?? null) : null;

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useShortcuts(layout === "web" ? { focusSearch: () => searchInput.current?.focus() } : {});

  const filters = useMemo(() => ({ accountId, categoryId, type }), [accountId, categoryId, type]);
  const { data: rows } = useTransactionList(period, filters, sort, search);
  const { data: totals } = usePeriodTotals(period, accountId);
  const { data: carryRows } = useCarryOver(period.start, accountId === null ? null : [accountId]);

  const visibleRows = useMemo(
    () => (hiddenIds.size === 0 ? rows : rows.filter((row) => !hiddenIds.has(row.id))),
    [rows, hiddenIds],
  );

  const theme = colors[resolveTheme(settings?.theme ?? "system", scheme ?? "light")];
  const currency = settings?.currency_code ?? "EUR";
  const iconStyle = settings?.icon_style ?? "filled";
  const carryOver = settings?.carry_over ? carryRows.reduce((sum, row) => sum + row.balance, 0) : 0;
  const income = (totals?.income ?? 0) + carryOver;
  const expense = totals?.expense ?? 0;

  const accountName = accounts.find((a) => a.id === accountId)?.name ?? "All Accounts";
  const title = categoryName ? `${accountName} · ${categoryName}` : accountName;

  const deleteRow = useCallback(
    (id: string) => {
      requestDelete(id);
      setToastVisible(true);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastVisible(false), UNDO_DELAY_MS);
    },
    [requestDelete],
  );

  const undoDelete = () => {
    undo();
    setToastVisible(false);
  };

  const menuOptions = (kind: MenuKind): MenuOption[] => {
    if (kind === "account") {
      return [
        { value: "", label: "All Accounts", selected: accountId === null },
        ...accounts.map((a) => ({ value: a.id, label: a.name, selected: a.id === accountId })),
      ];
    }
    if (kind === "sort") {
      return (Object.keys(SORT_LABELS) as TransactionSort[]).map((value) => ({
        value,
        label: SORT_LABELS[value],
        selected: value === sort,
      }));
    }
    const options: MenuOption[] = [
      { value: "", label: "All types", selected: type === null },
      ...(Object.keys(TYPE_LABELS) as Transaction["type"][]).map((value) => ({
        value,
        label: TYPE_LABELS[value],
        selected: value === type,
      })),
    ];
    if (categoryId) options.push({ value: "category", label: "All categories", selected: false });
    return options;
  };

  const select = (kind: MenuKind, value: string) => {
    setMenu(null);
    if (kind === "account") setAccountId(value || null);
    else if (kind === "sort") setSort(value as TransactionSort);
    else if (value === "category") setCategoryId(null);
    else setType((value || null) as Transaction["type"] | null);
  };

  const menuTitles: Record<MenuKind, string> = { account: "Account", filter: "Filter", sort: "Sort" };
  const web = layout === "web";

  return (
    <View style={[styles.screen, { backgroundColor: theme.row }]}>
      <PaperBar theme={theme} style={web ? styles.webBar : undefined}>
        {web ? (
          <>
            <View style={styles.searchBox}>
              <View pointerEvents="none" style={styles.searchIcon}>
                <ToolbarIcon d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.6-1.9L20 20" color={theme.accent} size={15} />
              </View>
              <TextInput
                ref={searchInput}
                value={searchText}
                onChangeText={setSearchText}
                placeholder="Search transactions ( / )"
                placeholderTextColor={theme.accent}
                accessibilityLabel="Search transactions"
                allowFontScaling
                style={[styles.search, { borderColor: theme.line, color: theme.ink, backgroundColor: theme.row }]}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose account"
              accessibilityValue={{ text: title }}
              onPress={() => setMenu("account")}
              style={(state) => [
                styles.accountChip,
                { borderColor: theme.line, backgroundColor: isHovered(state) || state.pressed ? theme.hover : theme.row },
              ]}
            >
              <Text allowFontScaling numberOfLines={1} style={[styles.chipText, { color: theme.ink }]}>
                <Text testID="paper-bar-title">{title}</Text>
                <Text style={{ color: theme.accent }}> ▾</Text>
              </Text>
            </Pressable>
            <View style={styles.barActions}>
              <BarButton label="Sort" onPress={() => setMenu("sort")} theme={theme} />
              <BarButton label="Filter" onPress={() => setMenu("filter")} theme={theme} />
              <ExportButton theme={theme} />
            </View>
          </>
        ) : (
          <Text testID="paper-bar-title" allowFontScaling style={[styles.barText, { color: theme.accent }]}>
            {title}
          </Text>
        )}
      </PaperBar>

      <View style={[styles.totals, { borderBottomColor: theme.line }]}>
        <Text
          testID="income-total"
          allowFontScaling
          style={[styles.total, { color: theme.listGreen, backgroundColor: `${theme.listGreen}26` }]}
        >
          {formatAmount(income, currency, locale)}
        </Text>
        <Text
          testID="expense-total"
          allowFontScaling
          style={[styles.total, { color: theme.listRed, backgroundColor: `${theme.listRed}1f`, borderLeftColor: theme.line }, styles.totalRight]}
        >
          {formatAmount(expense, currency, locale)}
        </Text>
      </View>

      <FlatList
        testID="transaction-list"
        style={styles.list}
        data={visibleRows}
        keyExtractor={(row) => row.id}
        initialNumToRender={20}
        ListEmptyComponent={
          <Text allowFontScaling style={[styles.empty, { color: theme.ink }]}>
            No transactions in this period
          </Text>
        }
        renderItem={({ item }) => (
          <ListItem
            row={item}
            layout={layout}
            locale={locale}
            iconStyle={iconStyle}
            theme={theme}
            onOpen={onOpen}
            onDelete={deleteRow}
          />
        )}
      />

      {web ? null : (
        <View style={[styles.toolbar, { borderTopColor: theme.line, backgroundColor: theme.paper }]}>
          <View style={styles.toolbarGroup}>
            <ToolbarButton label="Previous period" onPress={() => onShift(-1)}>
              <ToolbarIcon d="M15 5 8 12l7 7" color={theme.accent} />
            </ToolbarButton>
            <ToolbarButton label="Next period" onPress={() => onShift(1)}>
              <ToolbarIcon d="m9 5 7 7-7 7" color={theme.accent} />
            </ToolbarButton>
          </View>
          <View style={styles.toolbarGroup}>
            <ToolbarButton label="Filter" onPress={() => setMenu("filter")}>
              <ToolbarIcon d="M3 4h18l-7 9v7l-4-2v-5Z" color={theme.accent} filled />
            </ToolbarButton>
            <ToolbarButton label="Choose account" onPress={() => setMenu("account")}>
              <ToolbarIcon d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9c0-4 3.5-7 8-7s8 3 8 7Z" color={theme.accent} filled />
            </ToolbarButton>
          </View>
        </View>
      )}

      <UndoToast visible={toastVisible} onUndo={undoDelete} />

      {menu ? (
        <OptionMenu
          title={menuTitles[menu]}
          options={menuOptions(menu)}
          onSelect={(value) => select(menu, value)}
          onClose={() => setMenu(null)}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

/** Export is a later sub-project. The button shows, disabled, with a "Coming soon" tooltip on hover. */
function ExportButton({ theme }: { theme: ThemeColors }) {
  const [hover, setHover] = useState(false);
  return (
    <View testID="export" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <Pressable accessibilityRole="button" accessibilityLabel="Export" accessibilityHint="Coming soon" disabled>
        <Text allowFontScaling style={[styles.barAction, styles.barButton, styles.disabled, { color: theme.accent }]}>
          Export
        </Text>
      </Pressable>
      {hover ? (
        <Text style={[styles.tooltip, { backgroundColor: theme.ink, color: theme.paper }]}>Coming soon</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  webBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    zIndex: 1,
  },
  searchBox: {
    flex: 1,
    maxWidth: 220,
    justifyContent: "center",
  },
  searchIcon: {
    position: "absolute",
    left: 10,
    zIndex: 1,
  },
  accountChip: {
    flexShrink: 1,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 5,
    paddingHorizontal: 14,
  },
  chipText: {
    fontSize: 14,
  },
  barButton: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  barText: {
    fontSize: 15,
    textAlign: "center",
  },
  barActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  barAction: {
    fontSize: 13,
  },
  disabled: {
    opacity: 0.45,
  },
  tooltip: {
    position: "absolute",
    top: 22,
    right: 0,
    fontSize: 11,
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 3,
  },
  search: {
    height: 32,
    borderWidth: 1,
    borderRadius: 16,
    paddingLeft: 32,
    paddingRight: 12,
    fontSize: 13,
  },
  totals: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  total: {
    flex: 1,
    padding: 6,
    fontSize: 14,
    textAlign: "center",
  },
  totalRight: {
    borderLeftWidth: 1,
  },
  list: {
    flex: 1,
  },
  empty: {
    textAlign: "center",
    fontSize: 15,
    marginTop: 40,
  },
  toolbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 10,
    paddingBottom: 14,
    paddingHorizontal: 16,
    borderTopWidth: 1,
  },
  toolbarGroup: {
    flexDirection: "row",
    gap: 22,
  },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
  },
  menu: {
    minWidth: 220,
    borderWidth: 1,
    borderRadius: 6,
    paddingTop: 10,
  },
  menuTitle: {
    fontSize: 13,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  menuItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopWidth: 1,
  },
  menuText: {
    fontSize: 16,
  },
});
