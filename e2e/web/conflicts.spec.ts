import type { Browser, Page } from "@playwright/test";

import type { TestUser } from "../support/users.ts";
import {
  addTransaction,
  blockUploads,
  deleteWithKey,
  expect,
  goToPage,
  logIn,
  newAppContext,
  newUser,
  openTransaction,
  serverTransactionById,
  syncState,
  test,
  transactionRow,
  unblockUploads,
  waitForServerTransaction,
  waitForSynced,
} from "./fixtures.ts";

/** Edits the name and the note of a transaction in the form and saves it. */
async function edit(page: Page, name: string, change: { name?: string; note?: string }): Promise<void> {
  await openTransaction(page, name);
  if (change.name !== undefined) await page.getByPlaceholder("Name", { exact: true }).fill(change.name);
  if (change.note !== undefined) await page.getByPlaceholder("Add a note", { exact: true }).fill(change.note);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Edit Transaction" })).toBeHidden();
}

async function expectForm(page: Page, name: string, values: { name: string; note: string }): Promise<void> {
  await goToPage(page, "transactions");
  await expect(transactionRow(page, name)).toBeVisible({ timeout: 30_000 });
  await openTransaction(page, name);
  await expect(page.getByPlaceholder("Name", { exact: true })).toHaveValue(values.name);
  await expect(page.getByPlaceholder("Add a note", { exact: true })).toHaveValue(values.note);
  await page.getByRole("button", { name: "Close" }).click();
}

/** A user, logged in on two browser contexts, with one synced transaction. */
async function twoDevices(browser: Browser, page: Page, name: string) {
  const user: TestUser = await newUser();
  await logIn(page, user);
  await waitForSynced(page);
  await addTransaction(page, { type: "expense", amount: "8", name, category: "Eating Out" });
  await waitForSynced(page);
  const row = await waitForServerTransaction(user.userId, name);

  const second = await newAppContext(browser);
  await logIn(second.page, user);
  await waitForSynced(second.page);
  await goToPage(second.page, "transactions");
  await expect(transactionRow(second.page, name)).toBeVisible({ timeout: 30_000 });
  return { user, id: row.id, second };
}

test("edits to different fields both survive", async ({ browser, page, context }) => {
  const { id, second } = await twoDevices(browser, page, "Lunch");

  await blockUploads(context);
  await blockUploads(second.context);
  await edit(page, "Lunch", { name: "Lunch A" });
  await edit(second.page, "Lunch", { note: "note from B" });
  await unblockUploads(context);
  await unblockUploads(second.context);

  await expect.poll(() => serverTransactionById(id), { timeout: 60_000 }).toEqual({ name: "Lunch A", note: "note from B" });
  await waitForSynced(page);
  await waitForSynced(second.page);
  await expectForm(page, "Lunch A", { name: "Lunch A", note: "note from B" });
  await expectForm(second.page, "Lunch A", { name: "Lunch A", note: "note from B" });
  await second.context.close();
});

test("edits to the same field: the last upload wins", async ({ browser, page, context }) => {
  const { id, second } = await twoDevices(browser, page, "Dinner");

  await blockUploads(context);
  await blockUploads(second.context);
  await edit(page, "Dinner", { name: "Dinner A" });
  await edit(second.page, "Dinner", { name: "Dinner B" });

  await unblockUploads(context);
  await expect.poll(() => serverTransactionById(id)?.name, { timeout: 60_000 }).toBe("Dinner A");
  await unblockUploads(second.context);
  await expect.poll(() => serverTransactionById(id)?.name, { timeout: 60_000 }).toBe("Dinner B");

  await waitForSynced(page);
  await waitForSynced(second.page);
  for (const p of [page, second.page]) {
    await goToPage(p, "transactions");
    await expect(transactionRow(p, "Dinner B")).toBeVisible({ timeout: 30_000 });
    await expect(transactionRow(p, "Dinner A")).toHaveCount(0);
  }
  await second.context.close();
});

test("a delete wins over an offline edit", async ({ browser, page }) => {
  const { id, second } = await twoDevices(browser, page, "Snack");

  await blockUploads(second.context);
  await edit(second.page, "Snack", { name: "Snack edited offline" });

  await goToPage(page, "transactions");
  await deleteWithKey(page, "Snack");
  await expect.poll(() => serverTransactionById(id), { timeout: 30_000 }).toBeNull();

  await unblockUploads(second.context);
  await waitForSynced(second.page);
  expect(serverTransactionById(id)).toBeNull();
  for (const p of [page, second.page]) {
    await goToPage(p, "transactions");
    await expect(transactionRow(p, "Snack")).toHaveCount(0);
    await expect(transactionRow(p, "Snack edited offline")).toHaveCount(0);
  }
  await expect(syncState(second.page)).not.toHaveText(/^Needs attention/);
  await expect(second.page.getByText("Needs attention", { exact: true })).toHaveCount(0);
  await second.context.close();
});
