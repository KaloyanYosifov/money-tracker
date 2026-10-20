import { useRouter, type Href } from "expo-router";
import { Alert, Platform } from "react-native";

import { useSessionActions } from "../src/data/session";
import { DeskScreen } from "../src/ui/nav/DeskScreen";
import { Settings } from "../src/ui/screens/Settings";

export default function SettingsRoute() {
  const router = useRouter();
  const { logout, resetLocalData } = useSessionActions();

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/spending" as Href);
  };

  return (
    <DeskScreen>
      <Settings
        onClose={close}
        onOpenSyncProblems={() => router.push("/sync-problems" as Href)}
        onOpenSessions={() => router.push("/sessions" as Href)}
        onLogout={() => void logout().catch(showLogoutError)}
        onResetLocalData={() => void resetLocalData()}
      />
    </DeskScreen>
  );
}

function showLogoutError() {
  const message = "The server did not end the session. Check the connection and try again.";
  if (Platform.OS === "web") window.alert(message);
  else Alert.alert("Log out failed", message);
}
