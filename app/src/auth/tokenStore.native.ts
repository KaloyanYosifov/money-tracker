import * as SecureStore from "expo-secure-store";

const REFRESH_TOKEN_KEY = "auth_refresh_token";
const LAST_USER_ID_KEY = "auth_last_user_id";

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

async function write(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await SecureStore.deleteItemAsync(key, STORE_OPTIONS);
  } else {
    await SecureStore.setItemAsync(key, value, STORE_OPTIONS);
  }
}

export function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, STORE_OPTIONS);
}

export function setRefreshToken(token: string | null): Promise<void> {
  return write(REFRESH_TOKEN_KEY, token);
}

export function getLastUserId(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_USER_ID_KEY, STORE_OPTIONS);
}

export function setLastUserId(userId: string | null): Promise<void> {
  return write(LAST_USER_ID_KEY, userId);
}
