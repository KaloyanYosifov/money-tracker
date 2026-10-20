import type { BottomTabBarProps } from "expo-router/js-tabs";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PeriodPill } from "../components/PeriodPill";
import { TabIcon, type TabIconName } from "../icons/tabIcons";
import { colors, type ThemeColors } from "../theme";
import { usePeriod } from "./PeriodContext";

export interface Page {
  /** Route name in app/app/(main)/. */
  name: string;
  title: string;
  icon: TabIconName;
  /** The page shows the period controls in its header. */
  usesPeriod: boolean;
}

/** The pages in shortcut order (keys 1 to 5). The phone tabs show the first four. */
export const PAGES: readonly Page[] = [
  { name: "spending", title: "Spending", icon: "tag", usesPeriod: true },
  { name: "transactions", title: "Transactions", icon: "notepad", usesPeriod: true },
  { name: "categories", title: "Categories", icon: "cabinet", usesPeriod: false },
  { name: "accounts", title: "Accounts", icon: "people", usesPeriod: false },
  { name: "reports", title: "Reports", icon: "pie", usesPeriod: true },
];

const PHONE_TABS = PAGES.slice(0, 4);

export function pageFor(routeName: string): Page | undefined {
  return PAGES.find((page) => page.name === routeName);
}

type HeaderProps = {
  routeName: string;
  onMenu: () => void;
  topInset?: number;
  theme?: ThemeColors;
};

/** The phone header row: the period pill for pages with a period, and the ⋮ menu. */
export function PhoneHeader({ routeName, onMenu, topInset = 0, theme = colors.light }: HeaderProps) {
  const { kind, period, settings, setPeriod } = usePeriod();
  const page = pageFor(routeName);

  return (
    <View style={[styles.header, { paddingTop: topInset, backgroundColor: theme.paper }]}>
      <View style={styles.headerSide}>
        {page?.usesPeriod && (
          <PeriodPill period={period} kind={kind} settings={settings} onChange={setPeriod} theme={theme} />
        )}
      </View>
      <Pressable testID="menu" accessibilityRole="button" accessibilityLabel="Menu" onPress={onMenu} hitSlop={10} style={styles.menu}>
        <Text allowFontScaling style={[styles.menuText, { color: theme.accent }]}>
          ⋮
        </Text>
      </Pressable>
    </View>
  );
}

type Props = BottomTabBarProps & {
  position: "top" | "bottom";
  /** Opens Settings. */
  onMenu: () => void;
  theme?: ThemeColors;
};

/**
 * The phone and narrow browser navigation. At the top it also holds the
 * header row. At the bottom the layout puts the header row above the page.
 */
export function TabBar({ state, emitter, navigateToTab, insets, position, onMenu, theme = colors.light }: Props) {
  const focusedKey = state.routes[state.index]?.key;
  const focusedName = state.routes[state.index]?.name ?? "";
  const top = position === "top";

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: theme.paper, borderColor: theme.line },
        top ? styles.barTop : [styles.barBottom, { paddingBottom: insets.bottom }],
      ]}
    >
      {top && <PhoneHeader routeName={focusedName} onMenu={onMenu} topInset={insets.top} theme={theme} />}
      <View accessibilityRole="tablist" style={styles.tabs}>
        {PHONE_TABS.map((page) => {
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
              testID={`tab-${page.name}`}
              accessibilityRole="tab"
              accessibilityLabel={page.title}
              accessibilityState={{ selected: focused }}
              onPress={onPress}
              style={[
                styles.tab,
                top ? styles.tabTop : styles.tabBottom,
                focused && { borderColor: theme.ink },
              ]}
            >
              <TabIcon name={page.icon} filled={focused} color={theme.ink} background={theme.paper} />
              <Text allowFontScaling style={[styles.tabLabel, { color: theme.ink }]}>
                {page.title}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 50,
    paddingHorizontal: 14,
  },
  headerSide: {
    flex: 1,
  },
  menu: {
    paddingHorizontal: 6,
  },
  menuText: {
    fontSize: 22,
    fontWeight: "700",
  },
  bar: {
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 3,
  },
  barTop: {
    shadowOffset: { width: 0, height: 2 },
    zIndex: 2,
  },
  barBottom: {
    borderTopWidth: 1,
    shadowOffset: { width: 0, height: -2 },
  },
  tabs: {
    flexDirection: "row",
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingTop: 2,
    paddingBottom: 6,
    borderColor: "transparent",
  },
  tabTop: {
    borderBottomWidth: 3,
  },
  tabBottom: {
    borderTopWidth: 3,
  },
  tabLabel: {
    fontSize: 11.5,
  },
});
