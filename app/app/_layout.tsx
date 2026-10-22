import "../src/polyfills";

import { PowerSyncContext, useQuery } from "@powersync/react";
import { useFonts } from "expo-font";
import { Stack, usePathname, useRouter, type Href } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal, Platform, StyleSheet, useColorScheme, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { AuthProvider, useAuth, type AuthStatus } from "../src/auth/AuthProvider";
import { createConnector } from "../src/data/connector";
import { createDatabase, type AppDatabase } from "../src/data/db";
import {
  clearOnUserChange,
  confirmDialog,
  logout,
  resetLocalData,
  SessionActionsContext,
  type SessionActions,
} from "../src/data/session";
import { RecurringGenerator } from "../src/data/recurringGenerator";
import { UndoProvider } from "../src/data/UndoProvider";
import { AppLock, useAppLockCovered } from "../src/security/AppLock";
import { setUpdateRequired, useUpdateRequired } from "../src/sync/updateRequired";
import { ReauthLogin } from "../src/ui/auth/LoginForms";
import type { UserSettings } from "../src/generated/schema";
import { Banner } from "../src/ui/components/Banner";
import { useSessionEndCleanup } from "../src/ui/nav/sessionEnd";
import { colors, resolveTheme } from "../src/ui/theme";
import { installWebStyles } from "../src/ui/webStyles";

installWebStyles();

// In the browser these screens show as a card above the page (see DeskScreen), so the page stays visible below.
const FORM_PRESENTATION = Platform.OS === "web" ? "transparentModal" : "modal";
const PAGE_PRESENTATION = Platform.OS === "web" ? "transparentModal" : "card";

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    DroidSansMono: require("../assets/fonts/DroidSansMono.ttf"),
  });
  const [db, setDb] = useState<AppDatabase | null>(null);

  useEffect(() => {
    let alive = true;
    void createDatabase().then((created) => {
      if (alive) setDb(created);
    });
    return () => {
      alive = false;
    };
  }, []);

  const onUserChange = useMemo(() => (db ? clearOnUserChange(db) : undefined), [db]);
  const onSessionRevoked = useMemo(() => (db ? () => db.disconnectAndClear() : undefined), [db]);

  if ((!fontsLoaded && !fontError) || !db) {
    return null;
  }

  return (
    <AuthProvider onUserChange={onUserChange} onSessionRevoked={onSessionRevoked}>
      <AuthGate db={db} />
    </AuthProvider>
  );
}

function AuthGate({ db }: { db: AppDatabase }) {
  const { status, getAccessToken, refreshAccessToken, signOut } = useAuth();
  const [reauthOpen, setReauthOpen] = useState(true);
  const [shownStatus, setShownStatus] = useState(status);
  // The modal opens each time the session ends. Closing it leaves the banner.
  if (status !== shownStatus) {
    setShownStatus(status);
    if (status === "reauthRequired") setReauthOpen(true);
  }
  // The open forms, pages and overlays close first, so the login modal can show and navigation works after it.
  const screensClosed = useSessionEndCleanup(status);

  const connector = useMemo(
    () =>
      createConnector({
        getAccessToken,
        refreshAccessToken,
        // AuthProvider moves to reauthRequired itself when the refresh token is rejected.
        onReauthRequired: () => {},
        onUpdateRequired: setUpdateRequired,
      }),
    [getAccessToken, refreshAccessToken],
  );

  useEffect(() => {
    if (status === "signedIn") {
      void db.connect(connector);
    } else if (status === "signedOut") {
      void db.disconnect();
    }
  }, [db, status, connector]);

  const actions = useMemo<SessionActions>(
    () => ({
      logout: () =>
        logout({ db, signOut, confirm: confirmDialog }).catch((error: unknown) => {
          // The local data is gone, but the session still runs, so sync downloads the data again.
          void db.connect(connector);
          throw error;
        }),
      resetLocalData: () => resetLocalData({ db, connect: () => db.connect(connector), confirm: confirmDialog }),
    }),
    [db, signOut, connector],
  );

  if (status === "loading") {
    return null;
  }

  return (
    <PowerSyncContext.Provider value={db}>
      <SessionActionsContext.Provider value={actions}>
        {/* One provider for the list and the form, so a delete from the form outlives the form. */}
        <UndoProvider db={db}>
          <AppLock enabled={status !== "signedOut"}>
            <View style={styles.fill}>
              {status !== "signedOut" ? <RecurringGenerator /> : null}
              {status !== "signedOut" && Platform.OS === "web" ? <PagesBelowDeepLink /> : null}
              <SyncBanners status={status} onLogin={() => setReauthOpen(true)}>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Protected guard={status !== "signedOut"}>
                    <Stack.Screen name="(main)" />
                    <Stack.Screen name="transaction/[id]" options={{ presentation: FORM_PRESENTATION }} />
                    <Stack.Screen name="category/[id]" options={{ presentation: FORM_PRESENTATION }} />
                    <Stack.Screen name="account/[id]" options={{ presentation: FORM_PRESENTATION }} />
                    <Stack.Screen name="settings" options={{ presentation: PAGE_PRESENTATION }} />
                    <Stack.Screen name="sessions" options={{ presentation: PAGE_PRESENTATION }} />
                    <Stack.Screen name="sync-problems" options={{ presentation: PAGE_PRESENTATION }} />
                  </Stack.Protected>
                  <Stack.Protected guard={status === "signedOut"}>
                    <Stack.Screen name="(auth)/login" />
                    <Stack.Screen name="(auth)/login-totp" />
                    <Stack.Screen name="(auth)/invite" />
                  </Stack.Protected>
                </Stack>
              </SyncBanners>
            </View>
            <ReauthModal
              visible={status === "reauthRequired" && reauthOpen && screensClosed}
              onClose={() => setReauthOpen(false)}
            />
          </AppLock>
        </UndoProvider>
      </SessionActionsContext.Provider>
    </PowerSyncContext.Provider>
  );
}

// The screens that show as a card above the pages in the browser.
const CARD_PAGES = new Set(["/settings", "/sessions", "/sync-problems"]);

/**
 * A browser load or reload of a card page has no pages below it, so the card shows
 * on an empty backdrop. This puts the first page below the card, once per app load.
 */
function PagesBelowDeepLink() {
  const router = useRouter();
  const pathname = usePathname();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (CARD_PAGES.has(pathname) && !router.canGoBack()) {
      router.replace("/spending" as Href);
      router.push(pathname as Href);
    }
  }, [router, pathname]);
  return null;
}

/** A native modal shows above the app lock, so it closes while the lock covers the app. */
function ReauthModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const covered = useAppLockCovered();
  return (
    <Modal visible={visible && !covered} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ReauthLogin />
    </Modal>
  );
}

/**
 * Update the app, Log in again and Needs attention, above every screen of the signed-in app.
 * The banners take the top safe-area inset, so the screens below them get a top inset of 0.
 */
function SyncBanners({ status, onLogin, children }: { status: AuthStatus; onLogin: () => void; children: ReactNode }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const updateRequired = useUpdateRequired();
  const problems = useQuery<{ n: number }>("SELECT count(DISTINCT table_name || ':' || record_id) AS n FROM sync_problems");
  const settings = useQuery<Pick<UserSettings, "theme">>("SELECT theme FROM user_settings LIMIT 1");
  const theme = colors[resolveTheme(settings.data[0]?.theme ?? "system", scheme ?? "light")];
  const problemCount = problems.data[0]?.n ?? 0;
  const reauth = status === "reauthRequired";
  const shown = status !== "signedOut" && (updateRequired || reauth || problemCount > 0);
  const below = useMemo(() => (shown ? { ...insets, top: 0 } : insets), [shown, insets]);

  // The tree keeps the same shape with and without banners, so the screens below do not mount again.
  return (
    <>
      {shown ? (
        <View style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: theme.paper }}>
          {updateRequired ? (
            <Banner
              title="Update the app"
              text="This version can no longer sync. Your changes stay on this device until you update."
              theme={theme}
              {...(Platform.OS === "web" ? { actionLabel: "Reload", onAction: () => window.location.reload() } : {})}
            />
          ) : null}
          {reauth ? (
            <Banner
              title="Log in again"
              text="Your session has ended. Your changes stay on this device until you log in."
              actionLabel="Log in"
              onAction={onLogin}
              theme={theme}
            />
          ) : null}
          {problemCount > 0 ? (
            <Banner
              testID="banner-needs-attention"
              title="Needs attention"
              text={
                problemCount === 1
                  ? "The server did not accept 1 change."
                  : `The server did not accept ${problemCount} changes.`
              }
              actionLabel="Review"
              onAction={() => router.push("/sync-problems" as Href)}
              theme={theme}
            />
          ) : null}
        </View>
      ) : null}
      <SafeAreaInsetsContext.Provider value={below}>{children}</SafeAreaInsetsContext.Provider>
    </>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
