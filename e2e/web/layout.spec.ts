import { resetData } from "../support/stack.ts";
import { expect, logIn, newUser, pressShortcut, test } from "./fixtures.ts";

test.beforeAll(() => resetData());

const PAGES = [
  { key: "1", route: "spending", title: "Spending" },
  { key: "2", route: "transactions", title: "Transactions" },
  { key: "3", route: "categories", title: "Categories" },
  { key: "4", route: "accounts", title: "Accounts" },
  { key: "5", route: "reports", title: "Reports" },
];

test("the sidebar shows at 1280 px, keys 1 to 5 switch pages, and the tabs show at 800 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const user = await newUser();
  await logIn(page, user);

  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Expense" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu" })).toHaveCount(0);

  for (const { key, route, title } of PAGES) {
    await pressShortcut(page, key);
    await expect(page).toHaveURL(new RegExp(`/${route}$`));
    await expect(page.getByRole("heading", { name: title, exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: title, exact: true })).toHaveAttribute("aria-selected", "true");
  }

  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menu" }).filter({ visible: true })).toBeVisible();
  for (const title of ["Spending", "Transactions", "Categories", "Accounts"]) {
    await expect(page.getByRole("tab", { name: title, exact: true }).filter({ visible: true })).toBeVisible();
  }
});
