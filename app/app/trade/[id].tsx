import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { DeskScreen } from "../../src/ui/nav/DeskScreen";
import { TradeForm } from "../../src/ui/screens/TradeForm";

/** /trade/new?instrument=<id> opens an empty form. Any other ID opens an edit. */
export default function TradeRoute() {
  const router = useRouter();
  const { id, instrument } = useLocalSearchParams<{ id: string; instrument?: string }>();

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace((instrument ? `/instrument/${instrument}` : "/portfolio") as Href);
  };

  return (
    <DeskScreen>
      <TradeForm key={`${id}:${instrument ?? ""}`} id={id === "new" ? null : id} instrumentId={instrument} onClose={close} />
    </DeskScreen>
  );
}
