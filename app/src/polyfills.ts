import { getRandomValues } from "expo-crypto";

// Hermes on iOS has no global crypto. uuid (newId) needs crypto.getRandomValues, so take it from expo-crypto.
// The web and Node already have it.
const target = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof target.crypto?.getRandomValues !== "function") {
  target.crypto = { ...target.crypto, getRandomValues };
}
