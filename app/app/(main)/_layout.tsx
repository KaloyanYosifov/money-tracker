import { useQuery } from "@powersync/react";
import { useIsFocused, useRouter, type Href } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { useMemo } from "react";
import { Platform, StyleSheet, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSessionActions } from "../../src/data/session";
import type { PeriodSettings } from "../../src/domain/period";
import type { UserSettings } from "../../src/generated/schema";
import { useDevicePrefs } from "../../src/hooks/useDevicePrefs";
import { useLayoutMode } from "../../src/hooks/useLayoutMode";
import { useShortcuts, type QuickAddType } from "../../src/hooks/useShortcuts";
import { PeriodProvider } from "../../src/ui/nav/PeriodContext";
import { Sidebar, SidebarPage } from "../../src/ui/nav/Sidebar";
import { pagesFor, PhoneHeader, TabBar } from "../../src/ui/nav/TabBar";
import { reportsReplacesPage } from "../../src/ui/screens/Reports";
import { colors, resolveTheme } from "../../src/ui/theme";

const DEFAULT_PERIOD_SETTINGS: PeriodSettings = { week_start_day: 1, month_start_day: 1, year_start_month: 1 };

function newTransactionHref(type: QuickAddType): Href {
  return `/transaction/new?type=${type}` as Href;
}

export default function MainLayout() {
  const router = useRouter();
  const mode = useLayoutMode();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const { prefs } = useDevicePrefs();
  const { logout } = useSessionActions();
  // False while a form or Settings covers the pages, so their keys do not open pages below them.
  const focused = useIsFocused();
  const { data } = useQuery<UserSettings>("SELECT * FROM user_settings LIMIT 1");
  const settings = data[0];
  // SQLite keeps the boolean as 0 or 1. A page that is not in the list has no screen, so its tab is hidden.
  const insightsEnabled = Boolean(settings?.insights_enabled);
  const pages = useMemo(() => pagesFor(insightsEnabled), [insightsEnabled]);

  const theme = colors[resolveTheme(settings?.theme ?? "system", scheme ?? "light")];
  const weekStart = settings?.week_start_day;
  const monthStart = settings?.month_start_day;
  const yearStart = settings?.year_start_month;
  const periodSettings = useMemo<PeriodSettings>(
    () =>
      weekStart === undefined || monthStart === undefined || yearStart === undefined
        ? DEFAULT_PERIOD_SETTINGS
        : { week_start_day: weekStart, month_start_day: monthStart, year_start_month: yearStart },
    [weekStart, monthStart, yearStart],
  );

  const openSettings = () => router.push("/settings" as Href);
  const quickAdd = (type: QuickAddType) => router.push(newTransactionHref(type));

  useShortcuts(
    focused
      ? {
          page: (page) => {
            const target = pages[page - 1];
            if (target) router.navigate(`/${target.name}` as Href);
          },
          newTransaction: quickAdd,
        }
      : {},
  );

  const sidebar = mode === "sidebar";
  const tabsPosition = prefs.tabsPosition === "top" ? "top" : "bottom";

  return (
    <PeriodProvider settings={periodSettings} defaultKind={settings?.time_period ?? "monthly"}>
      <Tabs
        // In the browser each page change adds a history entry, so Back and Forward go through the visited pages.
        backBehavior={Platform.OS === "web" ? "fullHistory" : undefined}
        screenOptions={{
          headerShown: false,
          tabBarPosition: sidebar ? "left" : tabsPosition,
        }}
        tabBar={(props) =>
          // Reports in phone landscape is full screen.
          reportsReplacesPage(mode, props.state.routes[props.state.index]?.name ?? "") ? null : sidebar ? (
            <Sidebar {...props} onQuickAdd={quickAdd} onSettings={openSettings} onLogout={() => void logout().catch(showLogoutError)} theme={theme} />
          ) : (
            <TabBar {...props} position={tabsPosition} onMenu={openSettings} onAdd={() => quickAdd("expense")} theme={theme} />
          )
        }
        screenLayout={({ route, options, children }) => {
          if (reportsReplacesPage(mode, route.name)) return children;
          if (sidebar) {
            return (
              <SidebarPage routeName={route.name} title={options.title ?? route.name} theme={theme}>
                {children}
              </SidebarPage>
            );
          }
          // Phone landscape: the page keeps clear of the notch and the rounded corners.
          const sides = { paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: theme.paper };
          if (tabsPosition === "bottom") {
            return (
              <View style={[styles.fill, sides]}>
                <PhoneHeader
                  routeName={route.name}
                  onMenu={openSettings}
                  onAdd={() => quickAdd("expense")}
                  topInset={insets.top}
                  theme={theme}
                />
                {children}
              </View>
            );
          }
          return <View style={[styles.fill, sides]}>{children}</View>;
        }}
      >
        {pages.map((page) => (
          <Tabs.Screen key={page.name} name={page.name} options={{ title: page.title }} />
        ))}
      </Tabs>
    </PeriodProvider>
  );
}

/** The sidebar shows only in the browser. */
function showLogoutError() {
  window.alert("The server did not end the session. Check the connection and try again.");
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
