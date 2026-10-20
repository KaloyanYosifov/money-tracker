import { useRouter, type Href } from "expo-router";

import { SyncProblemsScreen, type ProblemEdit } from "../src/ui/screens/Settings";

const FORM_ROUTES: Record<string, string> = {
  transactions: "/transaction",
  categories: "/category",
  accounts: "/account",
};

export default function SyncProblemsRoute() {
  const router = useRouter();

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/settings" as Href);
  };

  const edit = ({ problemId, table, recordId }: ProblemEdit) => {
    const base = FORM_ROUTES[table];
    if (!base) return;
    router.push(`${base}/${encodeURIComponent(recordId)}?problem=${encodeURIComponent(problemId)}` as Href);
  };

  return <SyncProblemsScreen onEdit={edit} onClose={close} />;
}
