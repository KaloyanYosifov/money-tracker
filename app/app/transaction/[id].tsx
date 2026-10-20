import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { DeskScreen } from "../../src/ui/nav/DeskScreen";
import { TransactionForm } from "../../src/ui/screens/TransactionForm";

const TYPES = ["expense", "income", "transfer"] as const;

/** /transaction/new?type=expense|income|transfer opens an empty form. Any other ID opens an edit. */
export default function TransactionScreen() {
  const router = useRouter();
  const { id, type, problem } = useLocalSearchParams<{ id: string; type?: string; problem?: string }>();
  const initialType = TYPES.find((t) => t === type) ?? "expense";

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/transactions" as Href);
  };

  return (
    <DeskScreen>
      <TransactionForm
        key={`${id}:${initialType}`}
        id={id === "new" ? null : id}
        initialType={initialType}
        problemId={problem}
        onClose={close}
      />
    </DeskScreen>
  );
}
