import { randomUUID } from "node:crypto";

import { userIdByEmail } from "../support/db.ts";
import { resetData } from "../support/stack.ts";
import { codeAt } from "../support/totp.ts";
import { createInvite } from "../support/users.ts";
import {
  addTransaction,
  blockUploads,
  expect,
  expectSignedIn,
  goToPage,
  logIn,
  newUser,
  nextCode,
  serverTransactions,
  test,
  transactionRow,
  unblockUploads,
  waitForSynced,
} from "./fixtures.ts";

test.beforeAll(() => resetData());

test("an invite sets up the account through the UI", async ({ page }) => {
  const email = `invite-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const token = createInvite(email);

  await page.goto(`/invite?token=${encodeURIComponent(token)}`);
  await expect(page.getByRole("heading", { name: "Set up your account" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Repeat password", { exact: true }).fill(password);
  const accepted = page.waitForResponse((res) => res.url().endsWith("/api/auth/invite/accept"));
  await page.getByRole("button", { name: "Continue" }).click();
  const { secret } = (await (await accepted).json()) as { secret: string };

  await expect(page.getByRole("heading", { name: "Set up two-factor login" })).toBeVisible();
  await expect(page.getByText(secret, { exact: true })).toBeVisible();
  const confirmed = page.waitForResponse((res) => res.url().endsWith("/api/auth/invite/confirm"));
  await page.getByLabel("6-digit code").fill(await nextCode(secret));
  const { recovery_codes: codes } = (await (await confirmed).json()) as { recovery_codes: string[] };

  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  for (const code of codes) await expect(page.getByText(code, { exact: true })).toBeVisible();
  const cont = page.getByRole("button", { name: "Continue" });
  await expect(cont).toBeDisabled();
  await page.getByRole("checkbox", { name: "I saved these codes" }).click();
  await cont.click();

  await expectSignedIn(page);
  expect(userIdByEmail(email)).not.toBeNull();
});

test("login needs the password and a TOTP code, and a wrong code shows the error", async ({ page }) => {
  const user = await newUser();
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(`${user.password}-wrong`);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong email or password");

  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Two-factor code" })).toBeVisible();

  // A code from 10 minutes ago is outside the accepted window.
  const wrong = codeAt(user.totpSecret, Date.now() - 10 * 60_000);
  await page.getByLabel("6-digit code").fill(wrong);
  await expect(page.getByRole("alert")).toHaveText("Wrong code. Try again.");

  await page.getByLabel("6-digit code").fill(await nextCode(user.totpSecret));
  await expectSignedIn(page);
});

test("a recovery code works once", async ({ page }) => {
  const user = await newUser();
  const [recoveryCode] = user.recoveryCodes;

  async function loginWithRecoveryCode() {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.getByLabel("Recovery code", { exact: true }).fill(recoveryCode);
    await page.getByRole("button", { name: "Log in" }).click();
  }

  await loginWithRecoveryCode();
  await expectSignedIn(page);

  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Log in", exact: true })).toBeVisible();

  await loginWithRecoveryCode();
  await expect(page.getByRole("alert")).toHaveText("Wrong code. Try again.");
});

test("a reload keeps the session through the refresh cookie", async ({ page }) => {
  const user = await newUser();
  await logIn(page, user);

  const refreshed = page.waitForResponse((res) => res.url().endsWith("/api/auth/refresh"));
  await page.reload();
  expect((await refreshed).status()).toBe(200);
  await expectSignedIn(page);
  await expect(page.getByRole("heading", { name: "Log in", exact: true })).toHaveCount(0);
});

test("logout deletes the local data", async ({ page, context }) => {
  const user = await newUser();
  await logIn(page, user);
  await waitForSynced(page);

  // A change that never reaches the server exists only in the local database.
  await blockUploads(context);
  await addTransaction(page, { type: "expense", amount: "4.20", name: "Local only", category: "Eating Out" });
  await goToPage(page, "transactions");
  await expect(transactionRow(page, "Local only")).toBeVisible();

  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Log in", exact: true })).toBeVisible();
  expect(dialogs).toEqual(["1 change is not synced yet and will be lost. Log out?"]);
  await unblockUploads(context);

  await logIn(page, user);
  await waitForSynced(page);
  await goToPage(page, "transactions");
  await expect(transactionRow(page, "Local only")).toHaveCount(0);
  expect(serverTransactions(user.userId, "Local only")).toHaveLength(0);
});
