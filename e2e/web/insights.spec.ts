import { query } from "../support/db.ts";
import { psql } from "../support/stack.ts";
import { expect, logIn, newUser, test, waitForSynced } from "./fixtures.ts";

const FAKE_ANSWER = "This answer comes from the fake AI gateway.";

// The e2e stack runs the AI gateway with AI_FAKE=1. The fake daily run writes only a tip card,
// so the budget card is inserted on the server and syncs down like a card of the daily run.
test("turn on AI Insights, ask about a category and accept a budget card", async ({ page }) => {
  const user = await newUser();
  await logIn(page, user);
  await waitForSynced(page);

  // The tab shows only while the switch is on.
  await expect(page.getByRole("tab", { name: "AI Insights" })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // react-native-web renders two switch roles (the wrapper and the input), so find it by test ID.
  await page.getByTestId("insights-switch").click();
  await expect
    .poll(() => query("SELECT insights_enabled FROM user_settings WHERE user_id = :'user_id';", { user_id: user.userId }))
    .toEqual([["t"]]);
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("tab", { name: "AI Insights" }).click();
  await expect(page).toHaveURL(/\/insights$/);
  await expect(page.getByText("No suggestions yet.")).toBeVisible();

  // The on-demand path: the API worker sends the question to the fake gateway, and the answer syncs down.
  await page.getByTestId("ask-category").click();
  await page.getByRole("radiogroup", { name: "Category" }).getByRole("radio", { name: "Groceries", exact: true }).click();
  const question = page.getByLabel("Question", { exact: true });
  await question.fill("How much do I spend on groceries?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(question).toHaveValue("");
  await expect(page.getByText("How much do I spend on groceries?")).toBeVisible();
  await expect(page.getByText(FAKE_ANSWER)).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => query("SELECT status FROM insight_questions WHERE user_id = :'user_id';", { user_id: user.userId }))
    .toEqual([["answered"]]);

  // A budget card for Groceries.
  const groceries = query("SELECT id FROM categories WHERE user_id = :'user_id' AND name = 'Groceries';", {
    user_id: user.userId,
  })[0][0];
  const cardId = crypto.randomUUID();
  psql(
    `INSERT INTO insights (id, user_id, kind, title, body, fingerprint, status, action)
     VALUES (:'id', :'user_id', 'budget', 'Set a groceries budget', 'You spend about the same each month.',
             'e2e:budget', 'open', json_build_object('category_id', :'category_id', 'amount_minor', 20000));`,
    { vars: { id: cardId, user_id: user.userId, category_id: groceries } },
  );

  const card = page.getByTestId(`insight-card-${cardId}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Set budget" }).click();
  await expect(page.getByRole("heading", { name: "Budget for Groceries" })).toBeVisible();
  await page.getByLabel("Amount", { exact: true }).fill("150");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card).toBeHidden();

  await waitForSynced(page);
  await expect
    .poll(() =>
      query("SELECT amount_minor FROM budgets WHERE user_id = :'user_id' AND category_id = :'category_id';", {
        user_id: user.userId,
        category_id: groceries,
      }),
    )
    .toEqual([["15000"]]);
  await expect
    .poll(() => query("SELECT status FROM insights WHERE id = :'id';", { id: cardId }))
    .toEqual([["accepted"]]);
});
