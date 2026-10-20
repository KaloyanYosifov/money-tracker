import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

import type { AuthError } from "../../auth/api";
import { Texture } from "../Texture";
import { colors, MONO_FONT } from "../theme";

// The auth screens show before any user settings exist, so they always use the light paper style.
const theme = colors.light;

const ERROR_MESSAGES: Partial<Record<AuthError, string>> = {
  invalid_credentials: "Wrong email or password",
  locked: "Too many attempts. Try again in 15 minutes.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  invalid_code: "Wrong code. Try again.",
  setup_incomplete: "Finish the setup from your invite link first.",
  password_too_short: "Use at least 12 characters.",
  invite_invalid: "This invite link is not valid.",
  invite_expired: "This invite link has expired. Ask for a new one.",
  invite_used: "This invite link was already used.",
  invite_not_accepted: "Set your password first.",
  already_registered: "This account is already set up. Log in instead.",
  network: "No connection to the server. Try again.",
};

export function authErrorMessage(error: AuthError): string {
  return ERROR_MESSAGES[error] ?? "Something went wrong. Try again.";
}

export function AuthScreen({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <Texture kind="paper" style={styles.fill}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.card, { backgroundColor: theme.row, borderColor: theme.line }]}>
          <Text style={[styles.brand, { color: theme.accent }]}>Money Tracker</Text>
          <Text accessibilityRole="header" allowFontScaling style={[styles.title, { color: theme.ink }]}>
            {title}
          </Text>
          {text ? <Text style={[styles.text, { color: theme.ink }]}>{text}</Text> : null}
          {children}
        </View>
      </ScrollView>
    </Texture>
  );
}

export function AuthText({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <Text selectable={mono} style={[styles.text, { color: theme.ink }, mono && styles.mono]}>
      {children}
    </Text>
  );
}

export function AuthField({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.accent }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.line}
        style={[styles.input, { color: theme.ink, borderColor: theme.accent, backgroundColor: theme.paper }]}
        {...input}
      />
    </View>
  );
}

/** A 6-digit field that calls onComplete as soon as the sixth digit is typed. */
export function CodeField({ onComplete, disabled }: { onComplete: (code: string) => Promise<void>; disabled?: boolean }) {
  const [code, setCode] = useState("");
  return (
    <AuthField
      testID="totp-code"
      label="6-digit code"
      value={code}
      editable={!disabled}
      autoFocus
      keyboardType="number-pad"
      textContentType="oneTimeCode"
      autoComplete="one-time-code"
      maxLength={6}
      style={[styles.input, styles.code, { color: theme.ink, borderColor: theme.accent, backgroundColor: theme.paper }]}
      onChangeText={(text) => {
        const digits = text.replace(/\D/g, "").slice(0, 6);
        setCode(digits);
        if (digits.length === 6) {
          // Clear the field after each try, so a wrong code can be typed again.
          void onComplete(digits).finally(() => setCode(""));
        }
      }}
    />
  );
}

export function AuthButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: theme.accent }, disabled && styles.disabled]}
    >
      <Text style={[styles.buttonLabel, { color: theme.row }]}>{label}</Text>
    </Pressable>
  );
}

export function AuthLink({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={styles.link}
    >
      <Text style={[styles.linkLabel, { color: theme.accent }]}>{label}</Text>
    </Pressable>
  );
}

export function AuthCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      style={styles.checkboxRow}
    >
      <View style={[styles.checkbox, { borderColor: theme.accent }, checked && { backgroundColor: theme.accent }]}>
        {checked ? <Text style={[styles.checkmark, { color: theme.row }]}>✓</Text> : null}
      </View>
      <Text style={[styles.text, { color: theme.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <Text accessibilityRole="alert" style={[styles.error, { color: theme.listRed }]}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
  },
  card: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 6,
    padding: 24,
  },
  brand: {
    fontFamily: MONO_FONT,
    fontSize: 14,
    marginBottom: 6,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 12,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 10,
  },
  mono: {
    fontFamily: MONO_FONT,
  },
  field: {
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 4,
  },
  input: {
    borderWidth: 1.5,
    borderRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  code: {
    fontFamily: MONO_FONT,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: "center",
  },
  button: {
    borderRadius: 4,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 6,
  },
  disabled: {
    opacity: 0.45,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: "700",
  },
  link: {
    paddingVertical: 10,
    alignItems: "center",
  },
  linkLabel: {
    fontSize: 15,
    textDecorationLine: "underline",
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 10,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderRadius: 3,
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  checkmark: {
    fontSize: 14,
    fontWeight: "700",
  },
  error: {
    fontSize: 15,
    marginBottom: 10,
  },
});
