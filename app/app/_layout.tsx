import { PowerSyncContext, useQuery } from "@powersync/react";
import { useFonts } from "expo-font";
import { Stack, useRouter, type Href } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Modal, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { Banner } from "../src/ui/components/Banner";

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

  if ((!fontsLoaded && !fontError) || !db) {
    return null;
  }

  return (
    <AuthProvider onUserChange={onUserChange}>
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
      logout: () => logout({ db, signOut, confirm: confirmDialog }),
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
              {status !== "signedOut" ? <SyncBanners status={status} onLogin={() => setReauthOpen(true)} /> : null}
              {status !== "signedOut" ? <RecurringGenerator /> : null}
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Protected guard={status !== "signedOut"}>
                  <Stack.Screen name="(main)" />
                  <Stack.Screen name="transaction/[id]" options={{ presentation: "modal" }} />
                  <Stack.Screen name="category/[id]" options={{ presentation: "modal" }} />
                  <Stack.Screen name="account/[id]" options={{ presentation: "modal" }} />
                  <Stack.Screen name="settings" />
                  <Stack.Screen name="sessions" />
                  <Stack.Screen name="sync-problems" />
                </Stack.Protected>
                <Stack.Protected guard={status === "signedOut"}>
                  <Stack.Screen name="(auth)/login" />
                  <Stack.Screen name="(auth)/login-totp" />
                  <Stack.Screen name="(auth)/invite" />
                </Stack.Protected>
              </Stack>
            </View>
            <ReauthModal
              visible={status === "reauthRequired" && reauthOpen}
              onClose={() => setReauthOpen(false)}
            />
          </AppLock>
        </UndoProvider>
      </SessionActionsContext.Provider>
    </PowerSyncContext.Provider>
  );
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

/** Update the app, Log in again and Needs attention, above every screen of the signed-in app. */
function SyncBanners({ status, onLogin }: { status: AuthStatus; onLogin: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const updateRequired = useUpdateRequired();
  const problems = useQuery<{ n: number }>("SELECT count(*) AS n FROM sync_problems");
  const problemCount = problems.data[0]?.n ?? 0;
  const reauth = status === "reauthRequired";

  if (!updateRequired && !reauth && problemCount === 0) {
    return null;
  }

  return (
    <View style={{ paddingTop: insets.top }}>
      {updateRequired ? (
        <Banner
          title="Update the app"
          text="This version can no longer sync. Your changes stay on this device until you update."
          {...(Platform.OS === "web" ? { actionLabel: "Reload", onAction: () => window.location.reload() } : {})}
        />
      ) : null}
      {reauth ? (
        <Banner
          title="Log in again"
          text="Your session has ended. Your changes stay on this device until you log in."
          actionLabel="Log in"
          onAction={onLogin}
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
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
