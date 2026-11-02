import { useRouter, type Href } from "expo-router";

import { PortfolioScreen } from "../../src/ui/screens/Portfolio";

export default function PortfolioRoute() {
  const router = useRouter();

  return (
    <PortfolioScreen
      onOpen={(id) => router.push(`/instrument/${id}` as Href)}
      onAdd={() => router.push("/instrument/add" as Href)}
    />
  );
}
