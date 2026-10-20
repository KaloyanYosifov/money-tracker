import { useRouter, type Href } from "expo-router";
import { Platform } from "react-native";

import { useLayoutMode } from "../../src/hooks/useLayoutMode";
import { usePeriod } from "../../src/ui/nav/PeriodContext";
import { Chalkboard } from "../../src/ui/screens/Chalkboard";
import { reportsReplacesPage } from "../../src/ui/screens/Reports";
import { ReportsPage } from "./reports";

export default function SpendingScreen() {
  const router = useRouter();
  const { period } = usePeriod();
  const phone = Platform.OS === "ios" && !Platform.isPad;
  const mode = useLayoutMode();

  if (reportsReplacesPage(mode, "spending")) return <ReportsPage variant="landscape" />;

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
