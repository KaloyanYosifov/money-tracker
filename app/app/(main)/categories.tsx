import { useRouter, type Href } from "expo-router";

import { CategoriesScreen } from "../../src/ui/screens/Categories";

export default function CategoriesRoute() {
  const router = useRouter();

  return (
    <CategoriesScreen
      onOpen={(id) => router.push(`/category/${id}` as Href)}
      onNew={(type) => router.push(`/category/new?type=${type}` as Href)}
    />
  );
}
