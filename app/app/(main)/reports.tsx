import { useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLayoutMode } from "../../src/hooks/useLayoutMode";
import { usePeriod } from "../../src/ui/nav/PeriodContext";
import { Reports } from "../../src/ui/screens/Reports";

/** Reports for the shared period. Spending and Transactions render the "landscape" variant in phone landscape. */
export function ReportsPage({ variant = "page" }: { variant?: "page" | "landscape" }) {
  const router = useRouter();
  const mode = useLayoutMode();
  const insets = useSafeAreaInsets();
  const { kind, period, settings, shift } = usePeriod();

  return (
    <Reports
      period={period}
      kind={kind}
      settings={settings}
      variant={variant}
      showPeriodNav={mode !== "sidebar"}
      // Full screen has no header and no tab bar around it, so it keeps clear of the notch itself.
      style={
        variant === "landscape"
          ? { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }
          : undefined
      }
      onShift={shift}
      onCategoryPress={(categoryId) =>
        router.navigate({ pathname: "/transactions", params: { categoryId, tap: String(Date.now()) } } as unknown as Href)
      }
    />
  );
}

export default function ReportsScreen() {
  return <ReportsPage />;
}
