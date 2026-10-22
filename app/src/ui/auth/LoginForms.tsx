import { useState } from "react";

import { authApi } from "../../auth/api";
import { useAuth } from "../../auth/AuthProvider";
import { AuthButton, AuthField, AuthLink, AuthScreen, authErrorMessage, CodeField, ErrorText } from "./AuthUI";

export const SIGN_IN_FAILED = "Could not finish the login. Try again.";

// The MFA token goes from the login route to the TOTP route in memory, so it
// never shows in the web URL or the browser history.
let pendingMfaToken: string | null = null;

export function setPendingMfaToken(token: string | null): void {
  pendingMfaToken = token;
}

export function getPendingMfaToken(): string | null {
  return pendingMfaToken;
}

export function LoginForm({ onMfaToken }: { onMfaToken: (mfaToken: string) => void }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await authApi.login(email.trim(), password);
    setBusy(false);
    if (result.ok) {
      const value = result.value;
      if ("access_token" in value) {
        await signIn(value).catch(() => setError(SIGN_IN_FAILED));
      } else {
        onMfaToken(value.mfa_token);
      }
    } else {
      setError(authErrorMessage(result.error));
    }
  }

  return (
    <>
      <AuthField
        testID="login-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        textContentType="username"
        autoComplete="email"
      />
      <AuthField
        testID="login-password"
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="password"
        autoComplete="current-password"
        onSubmitEditing={() => {
          if (email.trim() && password && !busy) void submit();
        }}
      />
      <ErrorText message={error} />
      <AuthButton
        testID="login-submit"
        label="Log in"
        disabled={!email.trim() || !password || busy}
        onPress={() => void submit()}
      />
    </>
  );
}

export const TOTP_TEXT = "Type the 6-digit code from your authenticator app.";
export const RECOVERY_TEXT = "Type one of your recovery codes.";

export function TotpForm({
  mfaToken,
  onExpired,
  onRecoveryChange,
}: {
  mfaToken: string;
  onExpired: () => void;
  /** Called when the form changes between the 6-digit code and a recovery code. */
  onRecoveryChange?: (recovery: boolean) => void;
}) {
  const { signIn } = useAuth();
  const [useRecovery, setRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(input: { code?: string; recoveryCode?: string }) {
    setBusy(true);
    setError(null);
    const result = await authApi.loginTotp({ mfaToken, ...input });
    if (result.ok) {
      try {
        await signIn(result.value);
      } catch {
        setBusy(false);
        setError(SIGN_IN_FAILED);
      }
      return;
    }
    setBusy(false);
    if (result.error === "mfa_invalid") {
      onExpired();
    } else {
      setError(authErrorMessage(result.error));
    }
  }

  function setUseRecovery(recovery: boolean) {
    setRecovery(recovery);
    onRecoveryChange?.(recovery);
  }

  if (useRecovery) {
    const submitRecovery = () => {
      if (recoveryCode.trim() && !busy) void submit({ recoveryCode: recoveryCode.trim() });
    };
    return (
      <>
        <AuthField
          label="Recovery code"
          value={recoveryCode}
          onChangeText={setRecoveryCode}
          onSubmitEditing={submitRecovery}
          autoFocus
        />
        <ErrorText message={error} />
        <AuthButton label="Log in" disabled={!recoveryCode.trim() || busy} onPress={submitRecovery} />
        <AuthLink label="Use the authenticator app" onPress={() => setUseRecovery(false)} />
      </>
    );
  }

  return (
    <>
      <CodeField disabled={busy} onComplete={(code) => submit({ code })} />
      <ErrorText message={error} />
      <AuthLink label="Use a recovery code" onPress={() => setUseRecovery(true)} />
    </>
  );
}

/** The login and the TOTP step in one screen, for the modal over the app in reauthRequired. */
export function ReauthLogin() {
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  return (
    <AuthScreen title="Log in again" text="Your session has ended. Log in to sync your changes.">
      {mfaToken ? (
        <TotpForm mfaToken={mfaToken} onExpired={() => setMfaToken(null)} />
      ) : (
        <LoginForm onMfaToken={setMfaToken} />
      )}
    </AuthScreen>
  );
}
