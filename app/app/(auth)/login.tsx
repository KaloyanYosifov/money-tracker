import { useRouter, type Href } from "expo-router";

import { AuthScreen } from "../../src/ui/auth/AuthUI";
import { LoginForm, setPendingMfaToken } from "../../src/ui/auth/LoginForms";

export default function LoginScreen() {
  const router = useRouter();
  return (
    <AuthScreen title="Log in">
      <LoginForm
        onMfaToken={(mfaToken) => {
          setPendingMfaToken(mfaToken);
          router.push("/login-totp" as Href);
        }}
      />
    </AuthScreen>
  );
}
