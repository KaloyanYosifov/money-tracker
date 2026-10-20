import { Redirect, useRouter, type Href } from "expo-router";
import { useEffect, useState } from "react";

import { AuthScreen } from "../../src/ui/auth/AuthUI";
import { getPendingMfaToken, setPendingMfaToken, TotpForm } from "../../src/ui/auth/LoginForms";

export default function LoginTotpScreen() {
  const router = useRouter();
  const [mfaToken] = useState(getPendingMfaToken);

  useEffect(() => () => setPendingMfaToken(null), []);

  // A reload loses the in-memory MFA token, so the login starts again.
  if (!mfaToken) {
    return <Redirect href={"/login" as Href} />;
  }

  return (
    <AuthScreen title="Two-factor code" text="Type the 6-digit code from your authenticator app.">
      <TotpForm mfaToken={mfaToken} onExpired={() => router.replace("/login" as Href)} />
    </AuthScreen>
  );
}
