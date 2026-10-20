import { useRouter, type Href } from "expo-router";

import { AccountsScreen } from "../../src/ui/screens/Accounts";

export default function AccountsRoute() {
  const router = useRouter();

  return (
    <AccountsScreen
      onOpen={(id) => router.push(`/account/${id}` as Href)}
      onNew={() => router.push("/account/new" as Href)}
      onTransfer={() => router.push("/transaction/new?type=transfer" as Href)}
    />
  );
}
