import { query } from "../support/db.ts";
import { addTransaction, expect, goToPage, logIn, newUser, test, waitForSynced } from "./fixtures.ts";

test("set a category budget and see its progress", async ({ page }) => {
  const user = await newUser();
  await logIn(page, user);
  await waitForSynced(page);

  // Open the seeded Groceries category and give it a monthly budget.
  await goToPage(page, "categories");
  await page.getByRole("button", { name: "Groceries", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit Category" })).toBeVisible();
  await page.getByLabel("Monthly budget").fill("100");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Edit Category" })).toBeHidden();

  await addTransaction(page, { type: "expense", amount: "25", name: "Market", category: "Groceries", account: "Wallet" });

  // The desktop viewport uses the wide layout, so the budget shows on the line.
  await goToPage(page, "spending");
  await expect(page.getByText("€25.00 / €100.00")).toBeVisible();
  await expect(page.getByTestId("category-budget-bar").first()).toBeVisible();

  await waitForSynced(page);
  await expect
    .poll(() =>
      query(
        "SELECT period, amount_minor FROM budgets WHERE user_id = :'user_id' AND category_id IS NOT NULL;",
        { user_id: user.userId },
      ),
    )
    .toEqual([["monthly", "10000"]]);
});
