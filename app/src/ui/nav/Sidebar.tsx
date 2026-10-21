import type { BottomTabBarProps } from "expo-router/js-tabs";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { periodFor, type PeriodKind } from "../../domain/period";
import type { QuickAddType } from "../../hooks/useShortcuts";
import { useSyncState, type SyncStateKind } from "../../sync/syncState";
import { useUpdateRequired } from "../../sync/updateRequired";
import { isHovered } from "../components/interaction";
import { PeriodPill } from "../components/PeriodPill";
import { SegmentedControl } from "../components/SegmentedControl";
import { TabIcon } from "../icons/tabIcons";
import { Texture } from "../Texture";
import { colors, MONO_FONT, paperTint, type ThemeColors } from "../theme";
import { usePeriod } from "./PeriodContext";
import { PAGES, pageFor } from "./TabBar";

/** Width of the content card. It is the phone screen. */
export const CARD_WIDTH = 640;

const QUICK_ADD: { type: QuickAddType; label: string; key: string }[] = [
  { type: "expense", label: "+ Expense", key: "E" },
  { type: "income", label: "+ Income", key: "I" },
  { type: "transfer", label: "⇄ Transfer", key: "T" },
];

const SYNC_DOT: Record<SyncStateKind, string> = {
  synced: "#3fbf4a",
  syncing: "#3fbf4a",
  offline: "#e0a020",
  needsAttention: "#d0453a",
  reauthRequired: "#d0453a",
  updateRequired: "#d0453a",
};

type Props = BottomTabBarProps & {
  onQuickAdd: (type: QuickAddType) => void;
  onSettings: () => void;
  onLogout: () => void;
  theme?: ThemeColors;
};

/** The browser navigation at 900 px or more. */
export function Sidebar({ state, emitter, navigateToTab, onQuickAdd, onSettings, onLogout, theme = colors.light }: Props) {
  const sync = useSyncState(useUpdateRequired());
  const focusedKey = state.routes[state.index]?.key;

  return (
    <Texture kind="paper" tint={paperTint(theme)} style={[styles.side, { borderRightColor: theme.line }]}>
      <View style={[styles.brand, { borderBottomColor: theme.line }]}>
        <View style={[styles.logo, { backgroundColor: theme.chalkBackground }]}>
          <Text style={[styles.logoText, { color: theme.chalkGreen }]}>€</Text>
        </View>
        <View>
          <Text allowFontScaling style={[styles.brandName, { color: theme.ink }]}>
            Money Tracker
          </Text>
          <Text allowFontScaling style={[styles.brandSub, { color: theme.accent }]}>
            Personal finances
          </Text>
        </View>
      </View>

      <View accessibilityRole="tablist" style={styles.nav}>
        {PAGES.map((page, index) => {
          const route = state.routes.find((r) => r.name === page.name);
          if (!route) return null;
          const focused = route.key === focusedKey;
          const onPress = () => {
            const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigateToTab(route.key);
          };
          return (
            <Pressable
              key={page.name}
              accessibilityRole="tab"
              accessibilityLabel={page.title}
              accessibilityState={{ selected: focused }} aria-selected={focused}
              onPress={onPress}
              style={(state) => [
                styles.item,
                focused ? { backgroundColor: theme.line } : isHovered(state) || state.pressed ? { backgroundColor: theme.hover } : null,
              ]}
            >
              <TabIcon name={page.icon} filled={focused} size={30} color={theme.ink} background={theme.line} />
              <Text allowFontScaling style={[styles.itemText, { color: theme.ink }, focused && styles.itemTextOn]}>
                {page.title}
              </Text>
              <Text style={[styles.key, { backgroundColor: focused ? theme.paper : theme.hover, color: theme.accent }]}>{index + 1}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.separator, { backgroundColor: theme.line }]} />

      <View style={styles.quick}>
        {QUICK_ADD.map(({ type, label, key }) => {
          const primary = type === "expense";
          return (
            <Pressable
              key={type}
              accessibilityRole="button"
              accessibilityLabel={label.replace(/^[+⇄] /, "New ")}
              onPress={() => onQuickAdd(type)}
              style={(state) => [
                styles.quickButton,
                { borderColor: theme.accent },
                primary
                  ? { backgroundColor: theme.accent, opacity: state.pressed ? 0.8 : isHovered(state) ? 0.92 : 1 }
                  : (isHovered(state) || state.pressed) && { backgroundColor: theme.hover },
              ]}
            >
              <Text allowFontScaling style={[styles.quickText, { color: primary ? theme.paper : theme.accent }]}>
                {label}
              </Text>
              <Text style={[styles.quickText, styles.quickKey, { color: primary ? theme.paper : theme.accent }]}>{key}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.foot, { borderTopColor: theme.line }]}>
        <Pressable
          accessibilityRole="button"
          onPress={onSettings}
          style={(state) => [styles.footRow, styles.footButton, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
        >
          <TabIcon name="gear" size={24} color={theme.ink} background={theme.paper} />
          <Text allowFontScaling style={[styles.itemText, { color: theme.ink }]}>
            Settings
          </Text>
        </Pressable>
        <View accessibilityRole="text" accessibilityLabel={sync.label} style={styles.footRow}>
          <View style={[styles.dot, { backgroundColor: SYNC_DOT[sync.kind] }]} />
          <Text allowFontScaling style={[styles.footText, { color: theme.ink }]}>
            {sync.label}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onLogout} style={styles.footRow}>
          {(state) => (
            <Text allowFontScaling style={[styles.footText, { color: theme.accent }, isHovered(state) && styles.underline]}>
              Log out
            </Text>
          )}
        </Pressable>
      </View>
    </Texture>
  );
}

const KIND_OPTIONS: { value: PeriodKind; label: string }[] = [
  { value: "weekly", label: "W" },
  { value: "monthly", label: "M" },
  { value: "yearly", label: "Y" },
  { value: "custom", label: "Custom" },
];

type PageProps = {
  routeName: string;
  title: string;
  children: ReactNode;
  theme?: ThemeColors;
};

/** The page area next to the sidebar: the header row and the centred content card on the desk. */
export function SidebarPage({ routeName, title, children, theme = colors.light }: PageProps) {
  const { kind, period, settings, setPeriod, shift } = usePeriod();
  const usesPeriod = pageFor(routeName)?.usesPeriod ?? false;

  const onKind = (next: PeriodKind) => {
    if (next === "custom") setPeriod("custom", period);
    else setPeriod(next, periodFor(period.start, next, settings));
  };

  return (
    <Texture kind="paper" tint={paperTint(theme)} style={styles.desk}>
      <View style={styles.pageHeader}>
        <Text accessibilityRole="header" allowFontScaling style={[styles.title, { color: theme.ink }]}>
          {title}
        </Text>
        {usesPeriod && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous period"
              onPress={() => shift(-1)}
              hitSlop={4}
              style={(state) => [
                styles.arrowButton,
                { borderColor: theme.line, backgroundColor: isHovered(state) || state.pressed ? theme.hover : theme.row },
              ]}
            >
              <Text style={[styles.arrow, { color: theme.ink }]}>‹</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next period"
              onPress={() => shift(1)}
              hitSlop={4}
              style={(state) => [
                styles.arrowButton,
                { borderColor: theme.line, backgroundColor: isHovered(state) || state.pressed ? theme.hover : theme.row },
              ]}
            >
              <Text style={[styles.arrow, { color: theme.ink }]}>›</Text>
            </Pressable>
            {/* The pill aligns itself to the start, so a wrapper centres it in the row. */}
            <View>
              <PeriodPill period={period} kind={kind} settings={settings} onChange={setPeriod} theme={theme} />
            </View>
            <SegmentedControl options={KIND_OPTIONS} value={kind} onChange={onKind} theme={theme} />
          </>
        )}
      </View>
      <View style={[styles.card, { backgroundColor: theme.row }]}>{children}</View>
    </Texture>
  );
}

const styles = StyleSheet.create({
  side: {
    width: 232,
    borderRightWidth: 1,
    shadowColor: "#3c2314",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 2, height: 0 },
    zIndex: 2,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 18,
    borderBottomWidth: 1,
  },
  logo: {
    width: 34,
    height: 34,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    fontFamily: MONO_FONT,
    fontSize: 18,
  },
  brandName: {
    fontSize: 16,
    fontWeight: "600",
  },
  brandSub: {
    fontSize: 11,
  },
  nav: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    gap: 2,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  itemText: {
    fontSize: 14.5,
  },
  itemTextOn: {
    fontWeight: "600",
  },
  key: {
    marginLeft: "auto",
    minWidth: 18,
    textAlign: "center",
    fontSize: 10.5,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  separator: {
    height: 1,
    marginVertical: 8,
    marginHorizontal: 12,
  },
  quick: {
    paddingVertical: 4,
    paddingHorizontal: 20,
    gap: 8,
  },
  quickButton: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1.5,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  quickText: {
    fontSize: 13.5,
    fontWeight: "500",
  },
  quickKey: {
    fontSize: 11,
    opacity: 0.7,
  },
  foot: {
    marginTop: "auto",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderTopWidth: 1,
    gap: 10,
  },
  footRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  footButton: {
    marginHorizontal: -8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  footText: {
    fontSize: 12,
  },
  underline: {
    textDecorationLine: "underline",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  desk: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 22,
  },
  pageHeader: {
    width: CARD_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 36,
    marginBottom: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: "500",
    marginRight: "auto",
  },
  arrowButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  arrow: {
    fontSize: 20,
    lineHeight: 22,
    marginTop: -2,
  },
  card: {
    width: CARD_WIDTH,
    flex: 1,
    borderRadius: 8,
    overflow: "hidden",
    shadowColor: "#3c2314",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
  },
});
