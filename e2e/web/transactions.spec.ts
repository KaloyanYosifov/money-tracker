import {
  addTransaction,
  deleteWithKey,
  expect,
  goToPage,
  logIn,
  newUser,
  serverTransactions,
  test,
  transactionRow,
  waitForSynced,
} from "./fixtures.ts";

test("add, check totals and Carry Over, and delete with and without Undo", async ({ page }) => {
  const user = await newUser();
  await logIn(page, user);
  await waitForSynced(page);

  await addTransaction(page, { type: "expense", amount: "12.50", name: "Groceries run", category: "Groceries", account: "Wallet" });
  await addTransaction(page, { type: "income", amount: "100", name: "Pay day", category: "Salary", account: "Wallet" });

  const totals = "Income 100 euro, expense 12 euro 50, balance plus 87 euro 50";
  await goToPage(page, "spending");
  const summary = page.getByTestId("chalkboard-summary").filter({ visible: true });
  await expect(summary).toHaveAttribute("aria-label", totals);

  // A transfer moves money between accounts. For All Accounts the totals stay the same.
  await addTransaction(page, { type: "transfer", amount: "30", name: "To the bank", account: "Wallet", toAccount: "Bank" });
  await goToPage(page, "transactions");
  await expect(transactionRow(page, "To the bank")).toBeVisible();
  await goToPage(page, "spending");
  await expect(summary).toHaveAttribute("aria-label", totals);

  // The next month starts with one Carry Over row per account: Wallet 100 - 12.50 - 30, Bank 30.
  await goToPage(page, "transactions");
  await page.getByRole("button", { name: "Next period" }).filter({ visible: true }).click();
  await expect(page.getByLabel(/^Carry Over, carry over 57 euro 50, Wallet, /)).toBeVisible();
  await expect(page.getByLabel(/^Carry Over, carry over 30 euro, Bank, /)).toBeVisible();
  await expect(transactionRow(page, "Groceries run")).toHaveCount(0);
  await page.getByRole("button", { name: "Previous period" }).filter({ visible: true }).click();

  await waitForSynced(page);
  expect(serverTransactions(user.userId, "Groceries run")).toHaveLength(1);

  // Delete, then Undo: the row comes back and the server keeps it after the 5 seconds.
  await deleteWithKey(page, "Groceries run");
  await page.getByRole("button", { name: "Deleted. Undo" }).click();
  await expect(transactionRow(page, "Groceries run")).toBeVisible();
  await page.waitForTimeout(7_000);
  await waitForSynced(page);
  expect(serverTransactions(user.userId, "Groceries run")).toHaveLength(1);

  // Delete without Undo: the row is gone in PostgreSQL after the 5 seconds.
  await deleteWithKey(page, "Groceries run");
  await expect
    .poll(() => serverTransactions(user.userId, "Groceries run").length, { timeout: 30_000 })
    .toBe(0);
  await expect(transactionRow(page, "Groceries run")).toHaveCount(0);
});
