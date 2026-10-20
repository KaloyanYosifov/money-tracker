import { useRouter, type Href } from "expo-router";

import { useSessionActions } from "../src/data/session";
import { Settings } from "../src/ui/screens/Settings";

export default function SettingsRoute() {
  const router = useRouter();
  const { logout, resetLocalData } = useSessionActions();

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/spending" as Href);
  };

  return (
    <Settings
      onClose={close}
      onOpenSyncProblems={() => router.push("/sync-problems" as Href)}
      onOpenSessions={() => router.push("/sessions" as Href)}
      onLogout={() => void logout()}
      onResetLocalData={() => void resetLocalData()}
    />
  );
}
