import { useRouter, type Href } from "expo-router";
import { useMemo } from "react";

import { useAuth } from "../src/auth/AuthProvider";
import { createSessionsApi } from "../src/data/session";
import { SessionsScreen } from "../src/ui/screens/Settings";

export default function SessionsRoute() {
  const router = useRouter();
  const { getAccessToken, sessionId } = useAuth();
  const api = useMemo(() => createSessionsApi({ getAccessToken }), [getAccessToken]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/settings" as Href);
  };

  return <SessionsScreen api={api} currentSessionId={sessionId} onClose={close} />;
}
