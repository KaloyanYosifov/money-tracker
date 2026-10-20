import { Platform } from "react-native";

// Expo inlines EXPO_PUBLIC_* values at build time. Read them with the full
// process.env.NAME expression, or the bundler does not replace them.
const apiUrlFromEnv = process.env.EXPO_PUBLIC_API_URL;

export const API_URL: string =
  apiUrlFromEnv || (Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "");

export const POWERSYNC_URL: string = process.env.EXPO_PUBLIC_POWERSYNC_URL ?? "";

let runtimePowerSyncUrl: Promise<string> | null = null;

/**
 * The PowerSync URL. A build-time EXPO_PUBLIC_POWERSYNC_URL wins. Without it, the
 * web app reads the URL from /config.json, which the web image serves from its
 * POWERSYNC_URL environment variable, so one image works in each environment.
 */
export function getPowerSyncUrl(): Promise<string> {
  if (POWERSYNC_URL || Platform.OS !== "web") {
    return Promise.resolve(POWERSYNC_URL);
  }
  runtimePowerSyncUrl ??= fetch("/config.json")
    .then((res) => (res.ok ? res.json() : {}))
    .then((config: { powersyncUrl?: string }) => config.powersyncUrl ?? "")
    .catch(() => {
      // Try again on the next call, for example after the network comes back.
      runtimePowerSyncUrl = null;
      return "";
    });
  return runtimePowerSyncUrl;
}
