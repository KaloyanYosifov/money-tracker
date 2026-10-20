import { useQuery } from "@powersync/react";
import * as LocalAuthentication from "expo-local-authentication";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";

import { APP_LOCK_PREF, LOCK_AFTER_PREF } from "../hooks/useDevicePrefs";
import { defaultPlatform, useScreenSettings, type ScreenPlatform } from "../ui/screens/manage";

const CoveredContext = createContext(false);

/** True while the lock screen or the privacy cover hides the app. */
export function useAppLockCovered(): boolean {
  return useContext(CoveredContext);
}

/**
 * True when the device has a passcode or biometrics, false when it has neither,
 * null until the check finishes. App Lock cannot turn on without one of them.
 */
export function useAppLockAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    LocalAuthentication.getEnrolledLevelAsync().then(
      (level) => alive && setAvailable(level !== LocalAuthentication.SecurityLevel.NONE),
      () => alive && setAvailable(false),
    );
    return () => {
      alive = false;
    };
  }, []);
  return available;
}

type AppLockProps = {
  children: ReactNode;
  /** false for the signed-out screens. */
  enabled?: boolean;
  platform?: ScreenPlatform;
  now?: () => number;
};

/**
 * Face ID, Touch ID or passcode lock for the signed-in app, on iOS only. The
 * privacy cover hides the app in the app switcher.
 */
export function AppLock({ children, enabled = true, platform, now = Date.now }: AppLockProps) {
  if ((platform ?? defaultPlatform()) === "web") {
    return <>{children}</>;
  }
  // The same tree for both values of enabled, so a sign-in does not remount the app.
  return (
    <NativeAppLock enabled={enabled} now={now}>
      {children}
    </NativeAppLock>
  );
}

function NativeAppLock({ children, enabled, now }: { children: ReactNode; enabled: boolean; now: () => number }) {
  const { data, isLoading } = useQuery<{ key: string; value: string | null }>(
    "SELECT key, value FROM device_prefs WHERE key IN (?, ?)",
    [APP_LOCK_PREF, LOCK_AFTER_PREF],
  );
  const lockOn = enabled && data.some((row) => row.key === APP_LOCK_PREF && row.value === "on");
  const lockAfterMs = Number(data.find((row) => row.key === LOCK_AFTER_PREF)?.value ?? "0") * 1000 || 0;

  const [locked, setLocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [away, setAway] = useState(false);
  const [started, setStarted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [prevLockOn, setPrevLockOn] = useState(lockOn);
  const authenticating = useRef(false);
  const backgroundAt = useRef<number | null>(null);

  // The app starts locked. Turning the lock on later locks only after the next time away.
  if (!isLoading && !started) {
    setStarted(true);
    if (lockOn) {
      setLocked(true);
      setAttempt((n) => n + 1);
    }
  }
  if (lockOn !== prevLockOn) {
    setPrevLockOn(lockOn);
    if (!lockOn) {
      setLocked(false);
      setAway(false);
    }
  }

  useEffect(() => {
    if (attempt === 0 || authenticating.current) return;
    authenticating.current = true;
    LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Money Tracker", disableDeviceFallback: false })
      .then(
        (result) => {
          // The passcode was removed after App Lock turned on. Nothing can unlock, so do not lock the user out.
          if (result.success || result.error === "passcode_not_set") {
            setLocked(false);
          } else {
            setFailed(true);
          }
        },
        () => setFailed(true),
      )
      .finally(() => {
        authenticating.current = false;
      });
  }, [attempt]);

  useEffect(() => {
    if (!lockOn) {
      backgroundAt.current = null;
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        setAway(true);
        backgroundAt.current ??= now();
      } else if (state === "inactive") {
        // The Face ID prompt also makes the app inactive, so only the background counts as time away.
        setAway(true);
      } else if (state === "active") {
        setAway(false);
        const since = backgroundAt.current;
        backgroundAt.current = null;
        if (since !== null && now() - since >= lockAfterMs) {
          setLocked(true);
          setAttempt((n) => n + 1);
        }
      }
    });
    return () => subscription.remove();
  }, [lockOn, lockAfterMs, now]);

  const covered = !started || (lockOn && (locked || away));

  return (
    <CoveredContext.Provider value={covered}>
      <View style={styles.fill}>
        {children}
        {covered ? <LockScreen showUnlock={locked && failed && !away} onUnlock={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }} /> : null}
      </View>
    </CoveredContext.Provider>
  );
}

function LockScreen({ showUnlock, onUnlock }: { showUnlock: boolean; onUnlock: () => void }) {
  const { theme } = useScreenSettings();
  return (
    <View testID="privacy-cover" style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: theme.paper }]}>
      <Text allowFontScaling style={[styles.title, { color: theme.ink }]}>
        Money Tracker
      </Text>
      {showUnlock ? (
        <Pressable
          testID="unlock"
          accessibilityRole="button"
          accessibilityLabel="Unlock"
          onPress={onUnlock}
          style={[styles.button, { borderColor: theme.accent }]}
        >
          <Text allowFontScaling style={[styles.buttonText, { color: theme.accent }]}>
            Unlock
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  cover: {
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: "600",
  },
  button: {
    minHeight: 44,
    minWidth: 160,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 24,
  },
  buttonText: {
    fontSize: 17,
    fontWeight: "600",
  },
});
