import { randomUUID } from "node:crypto";
import { fetchWithRetry } from "./http.ts";
import { API_URL, compose } from "./stack.ts";
import { freshCode } from "./totp.ts";

export interface TestUser {
  userId: string;
  email: string;
  password: string;
  totpSecret: string;
  recoveryCodes: string[];
}

export interface CreateUserOptions {
  email?: string;
  password?: string;
  currency?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client": "native" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** Makes an invite with `mtapi admin invite` in the api container and returns its token. */
export function createInvite(email: string, currency = "EUR"): string {
  const out = compose(["exec", "-T", "api", "/mtapi", "admin", "invite", "--email", email, "--currency", currency]);
  const token = new URL(out.trim()).searchParams.get("token");
  if (!token) throw new Error(`no invite token in: ${out}`);
  return token;
}

/**
 * Creates a user with TOTP set up, through the real API.
 * The user has the default categories, accounts and settings.
 */
export async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const email = options.email ?? `e2e-${randomUUID()}@example.test`;
  const password = options.password ?? `pw-${randomUUID()}`;
  const token = createInvite(email, options.currency);

  const accepted = await post<{ secret: string }>("/api/auth/invite/accept", { token, password });
  const code = await freshCode(accepted.secret);
  const confirmed = await post<{ user_id: string; recovery_codes: string[] }>("/api/auth/invite/confirm", {
    token,
    code,
    device_name: "e2e setup",
  });

  return {
    userId: confirmed.user_id,
    email,
    password,
    totpSecret: accepted.secret,
    recoveryCodes: confirmed.recovery_codes,
  };
}
