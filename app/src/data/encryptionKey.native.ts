import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const KEY_NAME = "db_encryption_key";

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Returns the SQLCipher key for the local database as 64 hex characters.
// The first call makes a random 32-byte key and keeps it in the Keychain.
export async function getEncryptionKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_NAME, STORE_OPTIONS);
  if (existing) {
    return existing;
  }
  const bytes = await Crypto.getRandomBytesAsync(32);
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await SecureStore.setItemAsync(KEY_NAME, key, STORE_OPTIONS);
  return key;
}
