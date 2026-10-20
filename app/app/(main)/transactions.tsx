import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { useLayoutMode } from "../../src/hooks/useLayoutMode";
import { usePeriod } from "../../src/ui/nav/PeriodContext";
import { reportsReplacesPage } from "../../src/ui/screens/Reports";
import { TransactionList } from "../../src/ui/screens/TransactionList";
import { ReportsPage } from "./reports";

export default function TransactionsScreen() {
  const router = useRouter();
  const { period, shift } = usePeriod();
  const { categoryId, accountId } = useLocalSearchParams<{ categoryId?: string; accountId?: string }>();
  const mode = useLayoutMode();

  if (reportsReplacesPage(mode, "transactions")) return <ReportsPage variant="landscape" />;

  return (
    <TransactionList
      // Spending opens this tab with new filter params. A new key starts the list with them.
      key={`${accountId ?? ""}:${categoryId ?? ""}`}
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
