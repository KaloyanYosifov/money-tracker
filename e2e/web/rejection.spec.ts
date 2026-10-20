import { psql, resetData } from "../support/stack.ts";
import {
  addTransaction,
  blockUploads,
  expect,
  goToPage,
  logIn,
  newAppContext,
  newUser,
  serverTransactions,
  syncState,
  test,
  unblockUploads,
  waitForSynced,
} from "./fixtures.ts";

test.beforeAll(() => resetData());

test("a permanent rejection shows the banner, later changes sync, and Discard clears it", async ({ browser, page }) => {
  const user = await newUser();
  await logIn(page, user);
  await waitForSynced(page);

  const second = await newAppContext(browser);
  await logIn(second.page, user);
  await waitForSynced(second.page);

  // Context 2 saves while it cannot upload. The category is still there for it.
  await blockUploads(second.context);
  await addTransaction(second.page, { type: "expense", amount: "15", name: "Gift for Ana", category: "Gifts" });

  // Context 1 archives the category, and then the category is deleted on the server.
  await goToPage(page, "categories");
  await page.getByRole("button", { name: "Gifts", exact: true }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect
    .poll(
      () =>
        psql("SELECT count(*) FROM categories WHERE user_id = :'user_id' AND name = 'Gifts' AND archived_at IS NOT NULL;", {
          vars: { user_id: user.userId },
          readOnly: true,
        })[0][0],
      { timeout: 30_000 },
    )
    .toBe("1");
  psql("DELETE FROM categories WHERE user_id = :'user_id' AND name = 'Gifts';", { vars: { user_id: user.userId } });

  await unblockUploads(second.context);
  const banner = second.page.getByRole("alert").filter({ hasText: "Needs attention" });
  await expect(banner).toContainText("The server did not accept 1 change.", { timeout: 60_000 });
  await expect(syncState(second.page)).toHaveText("Needs attention · 1 problem");
  expect(serverTransactions(user.userId, "Gift for Ana")).toHaveLength(0);

  // The rejected change left the queue, so the next change still syncs.
  await addTransaction(second.page, { type: "expense", amount: "3", name: "Bread", category: "Groceries" });
  await expect.poll(() => serverTransactions(user.userId, "Bread").length, { timeout: 60_000 }).toBe(1);

  await banner.getByRole("button", { name: "Review" }).click();
  await second.page.getByRole("button", { name: /^Discard, / }).click();
  await expect(second.page.getByText("No sync problems.")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await waitForSynced(second.page);

  await second.context.close();
});
