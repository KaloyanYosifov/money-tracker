// The web keeps the refresh token in the HttpOnly mt_refresh cookie, so
// JavaScript never sees it. Only the last user ID is stored here.

const LAST_USER_ID_KEY = "auth_last_user_id";

export async function getRefreshToken(): Promise<string | null> {
  return null;
}

export async function setRefreshToken(_token: string | null): Promise<void> {}

export async function getLastUserId(): Promise<string | null> {
  return localStorage.getItem(LAST_USER_ID_KEY);
}

export async function setLastUserId(userId: string | null): Promise<void> {
  if (userId === null) {
    localStorage.removeItem(LAST_USER_ID_KEY);
  } else {
    localStorage.setItem(LAST_USER_ID_KEY, userId);
  }
}
