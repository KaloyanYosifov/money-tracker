import { Redirect, useRouter, type Href } from "expo-router";
import { useEffect, useState } from "react";

import { AuthScreen } from "../../src/ui/auth/AuthUI";
import { getPendingMfaToken, RECOVERY_TEXT, setPendingMfaToken, TOTP_TEXT, TotpForm } from "../../src/ui/auth/LoginForms";

export default function LoginTotpScreen() {
  const router = useRouter();
  const [mfaToken] = useState(getPendingMfaToken);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => () => setPendingMfaToken(null), []);

  // A reload loses the in-memory MFA token, so the login starts again.
  if (!mfaToken) {
    return <Redirect href={"/login" as Href} />;
  }

  return (
    <AuthScreen title="Two-factor code" text={recovery ? RECOVERY_TEXT : TOTP_TEXT}>
      <TotpForm
        mfaToken={mfaToken}
        onExpired={() => router.replace("/login" as Href)}
        onRecoveryChange={setRecovery}
      />
    </AuthScreen>
  );
}
