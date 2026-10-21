import { useRouter, type Href } from "expo-router";
import { Platform } from "react-native";

import { useLayoutMode } from "../../src/hooks/useLayoutMode";
import { usePeriod } from "../../src/ui/nav/PeriodContext";
import { Chalkboard } from "../../src/ui/screens/Chalkboard";
import { reportsReplacesPage } from "../../src/ui/screens/Reports";
import { TabletSplit } from "../../src/ui/screens/TabletSplit";
import { ReportsPage } from "./reports";

export default function SpendingScreen() {
  const router = useRouter();
  const { period, shift } = usePeriod();
  const phone = Platform.OS === "ios" && !Platform.isPad;
  const mode = useLayoutMode();

  if (reportsReplacesPage(mode, "spending")) return <ReportsPage variant="landscape" />;
  if (mode === "tabletSplit") {
    return (
      <TabletSplit
        period={period}
        onOpen={(id) => router.push(`/transaction/${id}` as Href)}
        onAdd={(type) => router.push(`/transaction/new?type=${type}` as Href)}
        onShift={shift}
      />
    );
  }

  return (
    <Chalkboard
      period={period}
      showRotateHint={phone}
      onCategoryPress={(categoryId, accountId) =>
        router.navigate({
          pathname: "/transactions",
          params: accountId ? { categoryId, accountId } : { categoryId },
        } as unknown as Href)
      }
      onAdd={(type) => router.push(`/transaction/new?type=${type}` as Href)}
    />
  );
}
