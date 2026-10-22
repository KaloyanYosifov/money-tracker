import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { useLayoutMode } from "../../src/hooks/useLayoutMode";
import { usePeriod } from "../../src/ui/nav/PeriodContext";
import { reportsReplacesPage } from "../../src/ui/screens/Reports";
import { TabletSplit } from "../../src/ui/screens/TabletSplit";
import { TransactionList } from "../../src/ui/screens/TransactionList";
import { ReportsPage } from "./reports";

export default function TransactionsScreen() {
  const router = useRouter();
  const { period, shift } = usePeriod();
  const { categoryId, accountId, tap } = useLocalSearchParams<{ categoryId?: string; accountId?: string; tap?: string }>();
  const mode = useLayoutMode();

  if (reportsReplacesPage(mode, "transactions")) return <ReportsPage variant="landscape" />;
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
    <TransactionList
      // Spending opens this tab with new filter params. A new key starts the list with them.
      key={`${accountId ?? ""}:${categoryId ?? ""}:${tap ?? ""}`}
      period={period}
      // The narrow browser uses the phone layout, with the bottom toolbar.
      layout={mode === "sidebar" ? "web" : "phone"}
      initialAccountId={accountId ?? null}
      initialCategoryId={categoryId ?? null}
      onOpen={(id) => router.push(`/transaction/${id}` as Href)}
      onShift={shift}
    />
  );
}
