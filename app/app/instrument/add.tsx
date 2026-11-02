import { useRouter, type Href } from "expo-router";
import { useMemo } from "react";

import { useAuth } from "../../src/auth/AuthProvider";
import { createInstrumentsApi } from "../../src/data/instrumentsApi";
import { DeskScreen } from "../../src/ui/nav/DeskScreen";
import { AddInstrumentScreen } from "../../src/ui/screens/AddInstrument";

export default function AddInstrumentRoute() {
  const router = useRouter();
  const { getAccessToken } = useAuth();
  const api = useMemo(() => createInstrumentsApi({ getAccessToken }), [getAccessToken]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/portfolio" as Href);
  };

  return (
    <DeskScreen>
      <AddInstrumentScreen
        api={api}
        onCancel={close}
        onAdded={(id) => router.replace(`/trade/new?instrument=${id}` as Href)}
      />
    </DeskScreen>
  );
}
