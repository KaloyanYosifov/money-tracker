import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { authApi, type TokenResponse } from "../../src/auth/api";
import { useAuth } from "../../src/auth/AuthProvider";
import {
  AuthButton,
  AuthCheckbox,
  AuthField,
  AuthLink,
  AuthScreen,
  AuthText,
  authErrorMessage,
  CodeField,
  ErrorText,
} from "../../src/ui/auth/AuthUI";

const MIN_PASSWORD_LENGTH = 12;

type Step =
  | { kind: "password" }
  | { kind: "totp"; otpauthUrl: string; secret: string }
  | { kind: "codes"; tokens: TokenResponse };

export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <AuthScreen title="Set up your account">
        <ErrorText message={authErrorMessage("invite_invalid")} />
      </AuthScreen>
    );
  }

  switch (step.kind) {
    case "password":
      return (
        <PasswordStep
          error={error}
          onSubmit={async (password) => {
            setError(null);
            const result = await authApi.acceptInvite(token, password);
            if (result.ok) {
              setStep({ kind: "totp", otpauthUrl: result.value.otpauth_url, secret: result.value.secret });
            } else {
              setError(authErrorMessage(result.error));
            }
          }}
        />
      );
    case "totp":
      return (
        <TotpStep
          otpauthUrl={step.otpauthUrl}
          secret={step.secret}
          error={error}
          onCode={async (code) => {
            setError(null);
            const result = await authApi.confirmInvite(token, code);
            if (result.ok) {
              setStep({ kind: "codes", tokens: result.value });
            } else {
              if (result.error === "invite_not_accepted") {
                setStep({ kind: "password" });
              }
              setError(authErrorMessage(result.error));
            }
          }}
        />
      );
    case "codes":
      return <RecoveryCodesStep tokens={step.tokens} />;
  }
}

function PasswordStep({ error, onSubmit }: { error: string | null; onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);

  const longEnough = [...password].length >= MIN_PASSWORD_LENGTH;
  const mismatch = repeat.length > 0 && password !== repeat;

  return (
    <AuthScreen title="Set up your account" text="Step 1 of 3. Choose a password with at least 12 characters.">
      <AuthField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
      />
      <AuthField
        label="Repeat password"
        value={repeat}
        onChangeText={setRepeat}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
      />
      <ErrorText message={mismatch ? "The passwords do not match." : error} />
      <AuthButton
        label="Continue"
        disabled={!longEnough || password !== repeat || busy}
        onPress={() => {
          setBusy(true);
          void onSubmit(password).finally(() => setBusy(false));
        }}
      />
    </AuthScreen>
  );
}

function TotpStep({
  otpauthUrl,
  secret,
  error,
  onCode,
}: {
  otpauthUrl: string;
  secret: string;
  error: string | null;
  onCode: (code: string) => Promise<void>;
}) {
  return (
    <AuthScreen
      title="Set up two-factor login"
      text="Step 2 of 3. Scan the QR code with your authenticator app, or type the secret into it. Then type the 6-digit code."
    >
      <View style={styles.qr}>
        <QRCode value={otpauthUrl} size={180} color="#4b3022" backgroundColor="#ffffff" />
      </View>
      <AuthText mono>{secret}</AuthText>
      <AuthLink label="Copy" accessibilityLabel="Copy secret" onPress={() => void Clipboard.setStringAsync(secret)} />
      <CodeField onComplete={onCode} />
      <ErrorText message={error} />
    </AuthScreen>
  );
}

function RecoveryCodesStep({ tokens }: { tokens: TokenResponse }) {
  const { signIn } = useAuth();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const codes = tokens.recovery_codes ?? [];

  return (
    <AuthScreen
      title="Save your recovery codes"
      text="Step 3 of 3. Each code works one time. Use a code to log in if you lose your authenticator app. Keep the codes in a safe place."
    >
      <View style={styles.codes}>
        {codes.map((code) => (
          <AuthText key={code} mono>
            {code}
          </AuthText>
        ))}
      </View>
      <AuthLink label="Copy all" onPress={() => void Clipboard.setStringAsync(codes.join("\n"))} />
      <AuthCheckbox label="I saved these codes" checked={saved} onChange={setSaved} />
      <AuthButton
        label="Continue"
        disabled={!saved || busy}
        onPress={() => {
          setBusy(true);
          void signIn(tokens);
        }}
      />
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  qr: {
    alignItems: "center",
    padding: 12,
    marginBottom: 10,
    backgroundColor: "#ffffff",
  },
  codes: {
    marginVertical: 6,
  },
});
