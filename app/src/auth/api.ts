import * as Device from "expo-device";
import { Platform } from "react-native";

import { API_URL } from "../config";

export type AuthError =
  | "invalid_credentials"
  | "invalid_code"
  | "locked"
  | "setup_incomplete"
  | "refresh_invalid"
  | "session_revoked"
  | "mfa_invalid"
  | "rate_limited"
  | "password_too_short"
  | "invite_invalid"
  | "invite_expired"
  | "invite_used"
  | "invite_not_accepted"
  | "already_registered"
  | "network"
  | "server";

const SERVER_ERRORS: ReadonlySet<string> = new Set<AuthError>([
  "invalid_credentials",
  "invalid_code",
  "locked",
  "setup_incomplete",
  "refresh_invalid",
  "session_revoked",
  "mfa_invalid",
  "rate_limited",
  "password_too_short",
  "invite_invalid",
  "invite_expired",
  "invite_used",
  "invite_not_accepted",
  "already_registered",
]);

export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthError };

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  user_id: string;
  session_id: string;
  /** Only on native. The web keeps the refresh token in an HttpOnly cookie. */
  refresh_token?: string;
  /** Only in the invite confirm response. */
  recovery_codes?: string[];
}

export interface AuthApi {
  /** Returns the tokens without the TOTP step when the API runs with DISABLE_TOTP. */
  login(email: string, password: string): Promise<AuthResult<{ mfa_token: string } | TokenResponse>>;
  loginTotp(input: {
    mfaToken: string;
    code?: string;
    recoveryCode?: string;
  }): Promise<AuthResult<TokenResponse>>;
  acceptInvite(
    token: string,
    password: string,
  ): Promise<AuthResult<{ otpauth_url: string; secret: string; totp_required?: boolean }>>;
  confirmInvite(token: string, code: string): Promise<AuthResult<TokenResponse>>;
  /** On the web, pass null: the browser sends the cookie. */
  refresh(refreshToken: string | null): Promise<AuthResult<TokenResponse>>;
  logout(refreshToken: string | null): Promise<AuthResult<void>>;
}

/** A readable name for the Devices list, for example "Chrome on macOS". */
export function webDeviceName(userAgent: string): string {
  const browser =
    [
      ["Edge", /Edg\//],
      ["Firefox", /Firefox\//],
      ["Chrome", /Chrome\//],
      ["Safari", /Safari\//],
    ].find(([, pattern]) => (pattern as RegExp).test(userAgent))?.[0] ?? "Browser";
  const os =
    [
      ["iOS", /iPhone|iPad/],
      ["Android", /Android/],
      ["macOS", /Mac OS X/],
      ["Windows", /Windows/],
      ["Linux", /Linux/],
    ].find(([, pattern]) => (pattern as RegExp).test(userAgent))?.[0];
  return os ? `${browser} on ${os}` : (browser as string);
}

export function createAuthApi(options: { apiUrl: string; platform: "native" | "web"; deviceName?: string }): AuthApi {
  const isNative = options.platform === "native";
  // Native sends X-Device-Name. The web sends the name in the body of the calls that start a session,
  // because a custom header needs a CORS preflight.
  const sessionBody = <T extends object>(body: T) =>
    !isNative && options.deviceName ? { ...body, device_name: options.deviceName } : body;

  async function post<T>(path: string, body?: object): Promise<AuthResult<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (isNative) {
      headers["X-Client"] = "native";
      headers["X-Device-Name"] = Device.modelName ?? "iOS device";
    } else {
      headers["X-Requested-With"] = "money-tracker";
    }

    let res: Response;
    try {
      res = await fetch(options.apiUrl + path, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: isNative ? undefined : "include",
      });
    } catch {
      return { ok: false, error: "network" };
    }

    let data: unknown;
    try {
      data = res.status === 204 ? undefined : await res.json();
    } catch {
      return { ok: false, error: "server" };
    }
    if (res.ok) {
      return { ok: true, value: data as T };
    }
    const code = (data as { error?: unknown } | undefined)?.error;
    return { ok: false, error: typeof code === "string" && SERVER_ERRORS.has(code) ? (code as AuthError) : "server" };
  }

  // The native refresh and logout send the token in the body. The web sends
  // no body, so the API reads the mt_refresh cookie.
  const tokenBody = (refreshToken: string | null) =>
    isNative ? { refresh_token: refreshToken ?? "" } : undefined;

  return {
    login: (email, password) => post("/api/auth/login", sessionBody({ email, password })),
    loginTotp: ({ mfaToken, code, recoveryCode }) =>
      post("/api/auth/login/totp", sessionBody({ mfa_token: mfaToken, code, recovery_code: recoveryCode })),
    acceptInvite: (token, password) => post("/api/auth/invite/accept", { token, password }),
    confirmInvite: (token, code) => post("/api/auth/invite/confirm", sessionBody({ token, code })),
    refresh: (refreshToken) => post("/api/auth/refresh", tokenBody(refreshToken)),
    logout: (refreshToken) => post("/api/auth/logout", tokenBody(refreshToken)),
  };
}

export const authApi: AuthApi = createAuthApi({
  apiUrl: API_URL,
  platform: Platform.OS === "web" ? "web" : "native",
  deviceName: typeof navigator !== "undefined" && navigator.userAgent ? webDeviceName(navigator.userAgent) : undefined,
});
