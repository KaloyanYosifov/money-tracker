import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { DeskScreen } from "../../src/ui/nav/DeskScreen";
import { CategoryForm } from "../../src/ui/screens/Categories";

/** /category/new?type=expense|income opens an empty form. Any other ID opens an edit. */
export default function CategoryRoute() {
  const router = useRouter();
  const { id, type, problem } = useLocalSearchParams<{ id: string; type?: string; problem?: string }>();
  const initialType = type === "income" ? "income" : "expense";

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/categories" as Href);
  };

  return (
    <DeskScreen>
      <CategoryForm
        key={`${id}:${initialType}`}
        id={id === "new" ? null : id}
        initialType={initialType}
        problemId={problem}
        onClose={close}
      />
    </DeskScreen>
  );
}
