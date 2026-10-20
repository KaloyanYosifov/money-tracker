import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { AccountForm } from "../../src/ui/screens/Accounts";

/** /account/new opens an empty form. Any other ID opens an edit. */
export default function AccountRoute() {
  const router = useRouter();
  const { id, problem } = useLocalSearchParams<{ id: string; problem?: string }>();

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/accounts" as Href);
  };

  return <AccountForm key={id} id={id === "new" ? null : id} problemId={problem} onClose={close} />;
}
