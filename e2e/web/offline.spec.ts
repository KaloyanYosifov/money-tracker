import { addLatency, goOffline, goOnline, resetProxies, setProxyEnabled } from "../support/toxiproxy.ts";
import {
  addTransaction,
  expect,
  logIn,
  newUser,
  serverTransactionCount,
  serverTransactions,
  syncState,
  test,
  waitForSynced,
} from "./fixtures.ts";

// This spec changes the one shared Toxiproxy, so playwright.config.ts runs it alone, after the other specs.
test.beforeEach(() => resetProxies());
test.afterEach(() => resetProxies());

test("changes made offline sync once, also after an upload that fails half way", async ({ page }) => {
  const user = await newUser();
  await logIn(page, user);
  await waitForSynced(page);

  await goOffline();
  await expect(syncState(page)).toHaveText("Offline · 0 pending", { timeout: 30_000 });
  for (const name of ["Offline 1", "Offline 2", "Offline 3"]) {
    await addTransaction(page, { type: "expense", amount: "1", name, category: "General" });
  }
  await expect(syncState(page)).toHaveText("Offline · 3 pending");

  await goOnline();
  await waitForSynced(page);
  expect(serverTransactionCount(user.userId)).toBe(3);

  // The API commits the upload, then the connection breaks before the response arrives.
  await addLatency("api", 4_000);
  const upload = page.waitForRequest((req) => req.url().endsWith("/api/sync/upload"));
  const failed = page.waitForResponse((res) => res.url().endsWith("/api/sync/upload") && res.status() >= 500);
  await addTransaction(page, { type: "expense", amount: "2", name: "Retried", category: "General" });
  await upload;
  await page.waitForTimeout(1_500);
  await setProxyEnabled("api", false);
  await failed;

  await resetProxies();
  await waitForSynced(page);
  expect(serverTransactions(user.userId, "Retried")).toHaveLength(1);
  expect(serverTransactionCount(user.userId)).toBe(4);
});
