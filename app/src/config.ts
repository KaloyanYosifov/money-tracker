import { Platform } from "react-native";

// Expo inlines EXPO_PUBLIC_* values at build time. Read them with the full
// process.env.NAME expression, or the bundler does not replace them.
const apiUrlFromEnv = process.env.EXPO_PUBLIC_API_URL;

export const API_URL: string =
  apiUrlFromEnv || (Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "");

export const POWERSYNC_URL: string = process.env.EXPO_PUBLIC_POWERSYNC_URL ?? "";
