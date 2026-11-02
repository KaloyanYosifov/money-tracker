import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { DeskScreen } from "../../src/ui/nav/DeskScreen";
import { InstrumentDetailScreen } from "../../src/ui/screens/InstrumentDetail";

export default function InstrumentRoute() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/portfolio" as Href);
  };

  return (
    <DeskScreen>
      <InstrumentDetailScreen
        key={id}
        id={id}
        onBack={close}
        onAddTrade={() => router.push(`/trade/new?instrument=${id}` as Href)}
        onOpenTrade={(tradeId) => router.push(`/trade/${tradeId}` as Href)}
      />
    </DeskScreen>
  );
}
