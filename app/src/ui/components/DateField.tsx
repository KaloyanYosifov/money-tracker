import { useContext, useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { periodFor, today as currentDay } from "../../domain/period";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { useCloseWithOverlays } from "../overlays";
import { colors, type ThemeColors } from "../theme";
import { isHovered } from "./interaction";

// Plain calendar dates as `YYYY-MM-DD`. The math runs in UTC, so the local time zone never shifts a day.

const DAY_MS = 86_400_000;

function toUtc(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtc(utc: Date): string {
  return utc.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return fromUtc(new Date(toUtc(date).getTime() + n * DAY_MS));
}

/** The first day of the month `n` months after the month of `date`. */
export function addMonths(date: string, n: number): string {
  const utc = toUtc(date);
  return fromUtc(new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth() + n, 1)));
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function monthEnd(date: string): string {
  return addDays(addMonths(date, 1), -1);
}

/** The 42 days (6 weeks) of the grid for the month of `month`, from the week start on or before its first day. */
export function monthGrid(month: string, weekStartDay: number): string[] {
  const start = periodFor(monthStart(month), "weekly", {
    week_start_day: weekStartDay,
    month_start_day: 1,
    year_start_month: 1,
  }).start;
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function format(date: string, locale: string | undefined, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(toUtc(date));
}

/** "Today", "Yesterday", else for example "Thu, 22 Oct 2026". */
export function dateFieldLabel(date: string, locale?: string, today: string = currentDay()): string {
  if (date === today) return "Today";
  if (date === addDays(today, -1)) return "Yesterday";
  const weekday = format(date, locale, { weekday: "short" });
  return `${weekday}, ${format(date, locale, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** Spoken name of a day cell, for example "22 October 2026". */
export function dayAccessibilityLabel(date: string, locale?: string): string {
  return format(date, locale, { day: "numeric", month: "long", year: "numeric" });
}

function inRange(date: string, minDate?: string, maxDate?: string): boolean {
  return (!minDate || date >= minDate) && (!maxDate || date <= maxDate);
}

function clamp(date: string, minDate?: string, maxDate?: string): string {
  if (minDate && date < minDate) return minDate;
  if (maxDate && date > maxDate) return maxDate;
  return date;
}

const ARROWS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export type CalendarKeyResult = { type: "close" } | { type: "select"; date: string } | { type: "move"; date: string } | null;

/** What a key does in the calendar on the web: Escape closes, the arrows move the cursor, Enter selects it. */
export function calendarKey(key: string, cursor: string, minDate?: string, maxDate?: string): CalendarKeyResult {
  if (key === "Escape") return { type: "close" };
  if (key === "Enter") return inRange(cursor, minDate, maxDate) ? { type: "select", date: cursor } : null;
  const step = ARROWS[key];
  if (step === undefined) return null;
  const next = addDays(cursor, step);
  return inRange(next, minDate, maxDate) ? { type: "move", date: next } : null;
}

type CalendarSheetProps = {
  visible: boolean;
  /** The selected day as `YYYY-MM-DD`, or "" for none. */
  value: string;
  onChange: (date: string) => void;
  onClose: () => void;
  /** 0 is Sunday, as in UserSettings.week_start_day. */
  weekStartDay?: number;
  minDate?: string;
  maxDate?: string;
  title?: string;
  locale?: string;
  today?: string;
  theme?: ThemeColors;
};

/** A month calendar in a bottom sheet (a centred card in the wide browser layout). A selected day closes it. */
export function CalendarSheet({
  visible,
  value,
  onChange,
  onClose,
  weekStartDay = 1,
  minDate,
  maxDate,
  title = "Date",
  locale,
  today = currentDay(),
  theme = colors.light,
}: CalendarSheetProps) {
  const initial = () => clamp(value || today, minDate, maxDate);
  const [month, setMonth] = useState(() => monthStart(initial()));
  const [cursor, setCursor] = useState<string | null>(null);
  const [wasVisible, setWasVisible] = useState(visible);
  const wide = useLayoutMode() === "sidebar";
  const bottomInset = useContext(SafeAreaInsetsContext)?.bottom ?? 0;
  useCloseWithOverlays(visible, onClose);

  // Each opening starts at the month of the value.
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setMonth(monthStart(initial()));
      setCursor(null);
    }
  }

  function select(date: string) {
    onChange(date);
    onClose();
  }

  const keyState = useRef({ cursor: cursor ?? initial(), minDate, maxDate, select, onClose });
  useEffect(() => {
    keyState.current = { cursor: cursor ?? initial(), minDate, maxDate, select, onClose };
  });

  useEffect(() => {
    if (Platform.OS !== "web" || !visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const state = keyState.current;
      const result = calendarKey(event.key, state.cursor, state.minDate, state.maxDate);
      if (!result) return;
      event.preventDefault();
      event.stopPropagation();
      if (result.type === "close") state.onClose();
      else if (result.type === "select") state.select(result.date);
      else {
        setCursor(result.date);
        setMonth(monthStart(result.date));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [visible]);

  const days = monthGrid(month, weekStartDay);
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const canPrev = !minDate || monthEnd(prevMonth) >= minDate;
  const canNext = !maxDate || nextMonth <= maxDate;
  const yesterday = addDays(today, -1);

  const navButton = (label: string, glyph: string, target: string, enabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={() => setMonth(target)}
      style={(state) => [styles.nav, isHovered(state) && { backgroundColor: theme.hover }, !enabled && styles.disabled]}
    >
      <Text allowFontScaling style={[styles.navText, { color: theme.ink }]}>
        {glyph}
      </Text>
    </Pressable>
  );

  const chip = (label: string, date: string) => {
    const enabled = inRange(date, minDate, maxDate);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        onPress={() => select(date)}
        style={(state) => [
          styles.chip,
          { borderColor: theme.accent },
          isHovered(state) && { backgroundColor: theme.hover },
          !enabled && styles.disabled,
        ]}
      >
        <Text allowFontScaling style={[styles.chipText, { color: theme.accent }]}>
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.root, wide && styles.rootWide]}>
        <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
        <View accessibilityViewIsModal style={[
            wide ? styles.card : [styles.sheet, { paddingBottom: Math.max(styles.sheet.paddingBottom, bottomInset) }],
            { backgroundColor: theme.row },
          ]}>
          <Text allowFontScaling accessibilityRole="header" style={[styles.title, { color: theme.accent }]}>
            {title}
          </Text>
          <View style={styles.header}>
            {navButton("Previous month", "‹", prevMonth, canPrev)}
            <Text allowFontScaling accessibilityRole="header" accessibilityLiveRegion="polite" style={[styles.month, { color: theme.ink }]}>
              {format(month, locale, { month: "long", year: "numeric" })}
            </Text>
            {navButton("Next month", "›", nextMonth, canNext)}
          </View>
          <View style={[styles.week, { borderBottomColor: theme.line }]}>
            {days.slice(0, 7).map((day) => (
              <Text key={day} allowFontScaling style={[styles.weekday, { color: theme.accent }]}>
                {format(day, locale, { weekday: "short" })}
              </Text>
            ))}
          </View>
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <View key={row} style={styles.week}>
              {days.slice(row * 7, row * 7 + 7).map((day) => {
                const enabled = inRange(day, minDate, maxDate);
                const selected = day === value;
                const isToday = day === today;
                const outside = day.slice(0, 7) !== month.slice(0, 7);
                return (
                  <Pressable
                    key={day}
                    testID={`day-${day}`}
                    accessibilityRole="button"
                    accessibilityLabel={dayAccessibilityLabel(day, locale)}
                    accessibilityHint={isToday ? "Today" : undefined}
                    accessibilityState={{ selected, disabled: !enabled }}
                    aria-selected={selected}
                    disabled={!enabled}
                    onPress={() => select(day)}
                    style={styles.cell}
                  >
                    {(state) => (
                      <View
                        testID={`day-${day}-mark`}
                        style={[
                          styles.mark,
                          isHovered(state) && !selected && { backgroundColor: theme.hover },
                          isToday && { borderColor: theme.accent },
                          selected && { backgroundColor: theme.accent, borderColor: theme.accent },
                          cursor === day && { borderColor: theme.ink, borderStyle: "dashed" },
                        ]}
                      >
                        <Text
                          allowFontScaling
                          style={[
                            styles.dayText,
                            { color: selected ? theme.row : theme.ink },
                            isToday && styles.todayText,
                            outside && !selected && styles.outside,
                            !enabled && styles.disabled,
                          ]}
                        >
                          {Number(day.slice(8))}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}
          <View style={[styles.footer, { borderTopColor: theme.line }]}>
            {chip("Today", today)}
            {chip("Yesterday", yesterday)}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={onClose}
              style={(state) => [styles.cancel, isHovered(state) && { backgroundColor: theme.hover }]}
            >
              <Text allowFontScaling style={[styles.cancelText, { color: theme.ink }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

type DateFieldProps = {
  /** `YYYY-MM-DD`, or "" for no date (only with allowEmpty). */
  value: string;
  onChange: (date: string) => void;
  /** Shown left of the value and as the title of the calendar. Leave it out inside a labelled Field. */
  label?: string;
  /** Adds a Clear action. An empty value shows the placeholder. */
  allowEmpty?: boolean;
  placeholder?: string;
  minDate?: string;
  maxDate?: string;
  /** 0 is Sunday, as in UserSettings.week_start_day. */
  weekStartDay?: number;
  /** Called when the calendar opens and closes, for example to pause the keyboard shortcuts of a form. */
  onOpenChange?: (open: boolean) => void;
  locale?: string;
  today?: string;
  theme?: ThemeColors;
  accessibilityLabel?: string;
  testID?: string;
};

/** A date as "Today", "Yesterday" or "Thu, 22 Oct 2026". A press opens the CalendarSheet. */
export function DateField({
  value,
  onChange,
  label,
  allowEmpty = false,
  placeholder = "None",
  minDate,
  maxDate,
  weekStartDay,
  onOpenChange,
  locale,
  today = currentDay(),
  theme = colors.light,
  accessibilityLabel,
  testID,
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const name = accessibilityLabel ?? label ?? "Date";
  const empty = value === "";
  const text = empty ? placeholder : dateFieldLabel(value, locale, today);

  function setOpenState(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  return (
    <View style={[styles.field, label !== undefined && [styles.labelled, { backgroundColor: theme.row, borderBottomColor: theme.line }]]}>
      {label !== undefined ? (
        <Text allowFontScaling style={[styles.label, { color: theme.accent }]}>
          {label}
        </Text>
      ) : null}
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${text}`}
        onPress={() => setOpenState(true)}
        style={(state) => [styles.value, isHovered(state) && { backgroundColor: theme.hover }]}
      >
        <Text allowFontScaling style={[styles.valueText, { color: empty ? theme.accent : theme.ink }]}>
          {text}
        </Text>
      </Pressable>
      {allowEmpty && !empty ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear ${name}`}
          onPress={() => onChange("")}
          hitSlop={8}
          style={(state) => [styles.clear, isHovered(state) && { backgroundColor: theme.hover }]}
        >
          <Text allowFontScaling style={[styles.clearText, { color: theme.accent }]}>
            Clear
          </Text>
        </Pressable>
      ) : null}
      <CalendarSheet
        visible={open}
        value={value}
        onChange={onChange}
        onClose={() => setOpenState(false)}
        weekStartDay={weekStartDay}
        minDate={minDate}
        maxDate={maxDate}
        title={label ?? accessibilityLabel}
        locale={locale}
        today={today}
        theme={theme}
      />
    </View>
  );
}

const CELL = 40;

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  rootWide: {
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  // On a tablet the sheet keeps a phone-like width in the middle, away from the rounded screen corners.
  sheet: {
    marginTop: "auto",
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingBottom: 24,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderRadius: 8,
    overflow: "hidden",
    shadowColor: "#3c2314",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
  },
  title: {
    fontSize: 13,
    paddingTop: 14,
    paddingHorizontal: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  nav: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
  },
  navText: {
    fontSize: 28,
    lineHeight: 32,
  },
  month: {
    fontSize: 18,
    fontWeight: "600",
  },
  week: {
    flexDirection: "row",
  },
  weekday: {
    flex: 1,
    textAlign: "center",
    fontSize: 12,
    paddingBottom: 6,
  },
  cell: {
    flex: 1,
    height: CELL + 4,
    alignItems: "center",
    justifyContent: "center",
  },
  mark: {
    width: CELL,
    height: CELL,
    borderRadius: CELL / 2,
    borderWidth: 1.5,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  dayText: {
    fontSize: 16,
  },
  todayText: {
    fontWeight: "700",
  },
  outside: {
    opacity: 0.4,
  },
  disabled: {
    opacity: 0.25,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 12,
    marginRight: 8,
  },
  chipText: {
    fontSize: 14,
  },
  cancel: {
    marginLeft: "auto",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
  },
  cancelText: {
    fontSize: 15,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
  },
  labelled: {
    minHeight: 48,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  label: {
    width: 84,
    fontSize: 13,
  },
  value: {
    flex: 1,
    minHeight: 24,
    justifyContent: "center",
    borderRadius: 4,
  },
  valueText: {
    fontSize: 16,
  },
  clear: {
    marginLeft: 8,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
  },
  clearText: {
    fontSize: 14,
  },
});
