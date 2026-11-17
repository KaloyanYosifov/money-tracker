import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { DeskScreen } from "../../src/ui/nav/DeskScreen";
import { SwapForm } from "../../src/ui/screens/SwapForm";

/** /swap/new?instrument=<id> opens an empty form with that "from" asset. Any other ID opens an edit. */
export default function SwapRoute() {
  const router = useRouter();
  const { id, instrument } = useLocalSearchParams<{ id: string; instrument?: string }>();

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace((instrument ? `/instrument/${instrument}` : "/portfolio") as Href);
  };

  return (
    <DeskScreen>
      <SwapForm key={`${id}:${instrument ?? ""}`} id={id === "new" ? null : id} instrumentId={instrument} onClose={close} />
    </DeskScreen>
  );
}
