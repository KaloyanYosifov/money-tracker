import type { Page } from "@playwright/test";

import { query } from "../support/db.ts";
import { expect, logIn, newUser, test, waitForSynced } from "./fixtures.ts";

interface Trade {
  /** A day of the previous month. Trades of one day sort by their random IDs, so each trade has its own day. */
  day: number;
  side: "Buy" | "Sell";
  quantity: `${number}`;
  price: `${number}`;
  fee: `${number}`;
}

function previousMonthDate(day: number) {
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() - 1, day);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${month.getFullYear()}-${pad(month.getMonth() + 1)}-${pad(day)}`;
}

/** Fills the open trade form and saves it. */
async function enterTrade(page: Page, trade: Trade): Promise<void> {
  const title = page.getByRole("heading", { name: "New trade" });
  await expect(title).toBeVisible();
  // The form is ready when the new asset has synced to this device.
  const quantity = page.getByLabel("Quantity", { exact: true });
  await expect(quantity).toBeVisible({ timeout: 60_000 });

  await page.getByRole("tab", { name: trade.side, exact: true }).click();
  await page.getByTestId("trade-date").click();
  await page.getByRole("button", { name: "Previous month", exact: true }).click();
  await page.getByTestId(`day-${previousMonthDate(trade.day)}`).click();
  // A browser can lose text that is typed while the date sheet still closes.
  await expect(page.getByRole("button", { name: "Previous month", exact: true })).toBeHidden();
  const price = page.getByLabel("Price per share (USD)", { exact: true });
  const fee = page.getByLabel("Fee (USD)", { exact: true });
  await quantity.fill(trade.quantity);
  await price.fill(trade.price);
  await fee.fill(trade.fee);
  await expect(quantity).toHaveValue(trade.quantity);
  await expect(price).toHaveValue(trade.price);
  await expect(fee).toHaveValue(trade.fee);
  await page.getByTestId("trade-save").click();
  await expect(title).toBeHidden();
}

test("add an asset, enter trades and see the value and the realized profit", async ({ page }) => {
  const user = await newUser({ currency: "EUR" });
  await logIn(page, user);
  await waitForSynced(page);

  await page.getByRole("tab", { name: "Portfolio", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByText("No assets yet")).toBeVisible();

  await page.getByRole("button", { name: "Add asset" }).filter({ visible: true }).click();
  await page.getByLabel("Name or ticker", { exact: true }).fill("acme");
  await page.getByRole("button", { name: /^ACME Test Corp, ACME/ }).click();

  await enterTrade(page, { day: 10, side: "Buy", quantity: "10", price: "80", fee: "1" });

  const row = page.getByRole("button", { name: /^ACME Test Corp, / });
  await row.click();
  await page.getByRole("button", { name: "Add trade" }).filter({ visible: true }).click();
  await enterTrade(page, { day: 11, side: "Buy", quantity: "5", price: "90", fee: "0" });
  await page.getByRole("button", { name: "Add trade" }).filter({ visible: true }).click();
  await enterTrade(page, { day: 12, side: "Sell", quantity: "4", price: "100", fee: "0" });

  // The fake source gives a close of 100 USD and a EURUSD rate of 1.25. FIFO sells 4 of the
  // first lot: 400 - 4 × 80.10 = 79.60. The 11 shares that stay are worth 1,100 USD.
  await expect(page.getByTestId("stat-Realized profit").filter({ visible: true })).toContainText("$79.60", {
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Back" }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "ACME Test Corp, €880.00" })).toBeVisible({ timeout: 60_000 });

  await waitForSynced(page);
  await expect
    .poll(() => query("SELECT count(*) FROM trades WHERE user_id = :'user_id';", { user_id: user.userId })[0][0])
    .toBe("3");
});
