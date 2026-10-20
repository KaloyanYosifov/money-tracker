import { test as base, expect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";

import { query } from "../support/db.ts";
import { waitForStack, WEB_URL } from "../support/stack.ts";
import { codeAt, msLeftInStep } from "../support/totp.ts";
import { resetProxies } from "../support/toxiproxy.ts";
import { createUser, type CreateUserOptions, type TestUser } from "../support/users.ts";

export { expect };

const STEP_MS = 30_000;
const MIN_LEFT_MS = 5_000;
const UPLOAD_URL = `${WEB_URL}/api/sync/upload`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The API accepts each TOTP step only once per user. This map keeps the last
// step that the suite used for each secret.
const lastStep = new Map<string, number>();

function markStepUsed(secret: string, at = Date.now()): void {
  lastStep.set(secret, Math.max(lastStep.get(secret) ?? -1, Math.floor(at / STEP_MS)));
}

/** A TOTP code of a step that the API did not see yet, with at least 5 seconds left. */
export async function nextCode(secret: string): Promise<string> {
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / STEP_MS);
    if (step > (lastStep.get(secret) ?? -1) && msLeftInStep(now) >= MIN_LEFT_MS) {
      lastStep.set(secret, step);
      return codeAt(secret, now);
    }
    await sleep(msLeftInStep(now) + 50);
  }
}

/** createUser, and the TOTP step that it used is marked as used. */
export async function newUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const user = await createUser(options);
  markStepUsed(user.totpSecret);
  return user;
}

let ipCounter = 0;

/**
 * Sends a different X-Real-IP for each browser context to the API. The login
 * rate limit is per IP, and all browsers of the suite share one real IP.
 */
async function useOwnClientIp(context: BrowserContext): Promise<string> {
  ipCounter += 1;
  const ip = `10.250.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
  await context.route(
    (url) => url.href.startsWith(`${WEB_URL}/api/`),
    (route) => route.fallback({ headers: { ...route.request().headers(), "x-real-ip": ip } }),
  );
  return ip;
}

/** A second browser context for the same browser, set up like the default one. */
export async function newAppContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: WEB_URL, locale: "en-GB" });
  await useOwnClientIp(context);
  const page = await context.newPage();
  return { context, page };
}

export const test = base.extend<{ clientIp: string; proxies: void }, { stack: void }>({
  stack: [
    async ({}, use) => {
      await waitForStack();
      await use();
    },
    { scope: "worker", auto: true },
  ],
  clientIp: [
    async ({ context }, use) => {
      await use(await useOwnClientIp(context));
    },
    { auto: true },
  ],
  // Every test starts and ends with both proxies on and no toxics.
  proxies: [
    async ({}, use) => {
      await resetProxies();
      await use();
      await resetProxies();
    },
    { auto: true },
  ],
});

const uploadBlockers = new WeakMap<BrowserContext, (route: Route) => Promise<void>>();

/** Makes the uploads of one context fail, as if this browser was offline. Downloads still work. */
export async function blockUploads(context: BrowserContext): Promise<void> {
  const handler = (route: Route) => route.abort("internetdisconnected");
  uploadBlockers.set(context, handler);
  await context.route(UPLOAD_URL, handler);
}

export async function unblockUploads(context: BrowserContext): Promise<void> {
  const handler = uploadBlockers.get(context);
  if (!handler) return;
  uploadBlockers.delete(context);
  await context.unroute(UPLOAD_URL, handler);
}

export async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByRole("tab", { name: "Spending" }).filter({ visible: true })).toBeVisible({ timeout: 30_000 });
}

/** Logs in through the UI and returns the access token from the TOTP response. */
export async function logIn(page: Page, user: TestUser): Promise<string> {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Two-factor code" })).toBeVisible();

  const code = await nextCode(user.totpSecret);
  const response = page.waitForResponse((res) => res.url().endsWith("/api/auth/login/totp"));
  await page.getByLabel("6-digit code").fill(code);
  const res = await response;
  expect(res.status()).toBe(200);
  await expectSignedIn(page);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

/** The sync state in the sidebar, for example "Offline · 3 pending". */
export function syncState(page: Page) {
  return page.getByText(/^(Synced|Not synced yet|Syncing|Offline|Needs attention)\b.* · \d+ (pending|problems?)$/);
}

export async function waitForSynced(page: Page): Promise<void> {
  await expect(syncState(page)).toHaveText(/^Synced .* · 0 pending$/, { timeout: 60_000 });
}

/** Presses a page shortcut with no text field in focus. */
export async function pressShortcut(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
}

const PAGE_KEYS = { spending: "1", transactions: "2", categories: "3", accounts: "4", reports: "5" } as const;

export async function goToPage(page: Page, name: keyof typeof PAGE_KEYS): Promise<void> {
  await pressShortcut(page, PAGE_KEYS[name]);
  await expect(page).toHaveURL(new RegExp(`/${name}`));
}

const KEYPAD_LABELS: Record<string, string> = { ".": "decimal point" };

export interface NewTransaction {
  type: "expense" | "income" | "transfer";
  /** Keypad input, for example "12.50". */
  amount: string;
  name: string;
  category?: string;
  account?: string;
  toAccount?: string;
}

const FORM_TITLES = { expense: "New Expense", income: "New Income", transfer: "New Transfer" } as const;

/** Adds a transaction with the E, I or T shortcut and saves it with Enter. */
export async function addTransaction(page: Page, t: NewTransaction): Promise<void> {
  await pressShortcut(page, t.type[0]);
  const title = page.getByRole("heading", { name: FORM_TITLES[t.type] });
  await expect(title).toBeVisible();

  await page.getByRole("button", { name: /^Amount, / }).click();
  for (const key of t.amount) {
    await page.getByRole("button", { name: KEYPAD_LABELS[key] ?? key, exact: true }).click();
  }
  const name = page.getByPlaceholder("Name", { exact: true });
  await name.fill(t.name);
  if (t.category) {
    await page.getByRole("radiogroup", { name: "Category" }).getByRole("radio", { name: t.category, exact: true }).click();
  }
  if (t.account) {
    const group = t.type === "transfer" ? "From" : "Account";
    await page.getByRole("radiogroup", { name: group }).getByRole("radio", { name: t.account, exact: true }).click();
  }
  if (t.toAccount) {
    await page.getByRole("radiogroup", { name: "To" }).getByRole("radio", { name: t.toAccount, exact: true }).click();
  }
  await name.press("Enter");
  await expect(title).toBeHidden();
}

/** The list row of a transaction, found by its name. */
export function transactionRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped}, `) });
}

/** Opens the edit form of a transaction from the Transactions page. */
export async function openTransaction(page: Page, name: string): Promise<void> {
  await goToPage(page, "transactions");
  await transactionRow(page, name).click();
  await expect(page.getByRole("heading", { name: "Edit Transaction" })).toBeVisible();
}

/** Deletes a transaction on the Transactions page with the Delete key. */
export async function deleteWithKey(page: Page, name: string): Promise<void> {
  const row = transactionRow(page, name);
  await row.focus();
  await page.keyboard.press("Delete");
  await expect(row).toBeHidden();
}

/** Server rows of one user's transactions with this name. */
export function serverTransactions(userId: string, name: string): { id: string; name: string; note: string }[] {
  return query(
    "SELECT id, name, coalesce(note, '') FROM transactions WHERE user_id = :'user_id' AND name = :'name' ORDER BY id;",
    { user_id: userId, name },
  ).map(([id, rowName, note]) => ({ id, name: rowName, note }));
}

export function serverTransactionCount(userId: string): number {
  return Number(query("SELECT count(*) FROM transactions WHERE user_id = :'user_id';", { user_id: userId })[0][0]);
}

export function serverTransactionById(id: string): { name: string; note: string } | null {
  const row = query("SELECT name, coalesce(note, '') FROM transactions WHERE id = :'id';", { id })[0];
  return row ? { name: row[0], note: row[1] } : null;
}
