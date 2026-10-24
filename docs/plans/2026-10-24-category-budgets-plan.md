# Category Budgets Implementation Plan

**Goal:** Let a user set a budget for each expense category, edit it in the category form, and see the progress of each category budget on the Spending chalkboard.

**Architecture:** The `budgets` table already has a nullable `category_id`. Today the app uses only the row with `category_id IS NULL` (the overall budget). This plan adds a mutation that writes or deletes the budget of one category for the `time_period` setting, a query that returns the spent amount of each category budget in the shown period, a Budget field in `CategoryForm`, and a thin progress bar under each budgeted expense line on the chalkboard. No server, schema or sync change is necessary.

**Tech Stack:** TypeScript, Expo (React Native and web), PowerSync, Jest with `better-sqlite3`, Playwright.

---

## Context

- A category budget is a `budgets` row with `category_id` set and `period` equal to `user_settings.time_period`. This is the same rule as for the overall budget in `saveOverallBudget` (`app/src/data/mutations.ts`) and `budgetProgress` (`app/src/data/queries.ts`). If the user changes the Time Period, the budgets of the old period stay in the database, but the app does not show them. That is also the behaviour of the overall budget today.
- Only expense categories can have a budget. An archived category keeps its budget row, but the chalkboard does not show archived categories in the budget bars.
- Category budgets show on the chalkboard if they exist. They do not depend on Budget Mode. Budget Mode controls only the overall bar, as today.
- The bars show only when the chalkboard shows "All Accounts". A budget is for all accounts, so a bar on the view of one account gives a wrong picture.
- The spent amount uses the same `visible` filter as `categoryTotals`, so future transactions follow the Hide Future setting.
- A category that has a budget is "used" in `deleteCategory` and in the `usage` query of `CategoryForm`. That stays as it is: to delete such a category, the user first clears its budget.
- Phone layout: a second line "of 500.00 · 89.80 left" (or "32.00 over" in red) and a 5 px bar under the category line. Wide layout (`useLayoutMode() === "sidebar"`): " / 500.00" after the amount on the same line, and the bar under it. The mockup is the `ai-insights-budget-options` visual, screens "Option 2".

## File Structure

| File | Responsibility |
|---|---|
| `app/src/data/mutations.ts` | `writeCategoryBudget` (inside a transaction) and `saveCategoryBudget` |
| `app/src/data/queries.ts` | `categoryBudgets` query and `useCategoryBudgets` hook |
| `app/src/ui/screens/Categories.tsx` | Budget field in `CategoryFormBody` |
| `app/src/ui/screens/Chalkboard.tsx` | Budget bar and text under the expense category lines |
| `app/src/data/mutations.test.ts`, `app/src/data/queries.test.ts`, `app/src/ui/screens/CategoriesAccounts.test.tsx`, `app/src/ui/screens/Chalkboard.test.tsx` | Tests |
| `e2e/web/category-budgets.spec.ts` | One web e2e test |

---

### Task 1: saveCategoryBudget mutation

**Files:**
- Modify: `app/src/data/mutations.ts`
- Test: `app/src/data/mutations.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/data/mutations.test.ts`, add `describe("saveCategoryBudget")`. Use the database and fixture helpers that the other `describe` blocks of the file use. Add these cases:

1. "inserts a budget for an expense category": call `saveCategoryBudget(db, foodId, "monthly", 50000)`. Assert the result is `{ ok: true, id }`, and that `budgets` has one row with `category_id = foodId`, `period = "monthly"`, `amount_minor = 50000` and the `user_id` of the settings row.
2. "updates the existing budget": call it two times with 50000, then 45000. Assert there is still one row for the category and period, with `amount_minor = 45000` and the same `id` as after the first call.
3. "keeps budgets of other periods": insert a `weekly` budget for the category in the fixture, then save a `monthly` one. Assert both rows exist.
4. "deletes the budget for null": save 50000, then call it with `null`. Assert there is no `budgets` row for the category and period, and the result is `{ ok: true, id }` with the id of the deleted row.
5. "null with no budget does nothing": call it with `null` for a category with no budget. Assert the result is `{ ok: true, id: "" }` and `budgets` has no new row.
6. "rejects an income category": assert the result is `{ ok: false }` with an error `{ field: "category_id", code: "invalid" }`, and no row is written.
7. "rejects an amount out of range": for `0`, `1.5` and `MAX_AMOUNT_MINOR + 1`, assert an error `{ field: "amount_minor", code: "out_of_range" }`.
8. "does not touch the overall budget": with an overall budget (`category_id` null) in the fixture, save a category budget and assert the overall row is unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- mutations.test.ts -t saveCategoryBudget`
Expected: FAIL, `saveCategoryBudget` is not exported.

- [ ] **Step 3: Write the implementation**

In `app/src/data/mutations.ts`, add an exported `writeCategoryBudget(tx: SqlRunner, categoryId: string, period: UserSettings["time_period"], amountMinor: number | null): Promise<SaveResult>`:

- Read the category with `SELECT type FROM categories WHERE id = ?`. If there is no row, or `type` is not `expense`, return the `category_id` / `invalid` error.
- If `amountMinor` is not `null`, apply the same range check as `saveOverallBudget` (integer, at least 1, at most `MAX_AMOUNT_MINOR`), with the same error.
- Look up the existing row with `SELECT id FROM budgets WHERE category_id = ? AND period = ? ORDER BY id LIMIT 1`.
- For `null`: if a row exists, `DELETE FROM budgets WHERE id = ?` and return its id. Otherwise return `{ ok: true, id: "" }`.
- For an amount: call the existing `write` helper on `budgets` with the existing id and `{ amount_minor }`. The insert-only values are `user_id` from `currentSettings(tx)`, `category_id` and `period`.

Then add `saveCategoryBudget(db: MutationDb, categoryId, period, amountMinor)`, which runs `writeCategoryBudget` inside `db.writeTransaction`. `writeCategoryBudget` is exported because the AI Insights plan calls it inside a larger transaction.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- mutations.test.ts`
Expected: PASS, all tests of the file.

---

### Task 2: categoryBudgets query

**Files:**
- Modify: `app/src/data/queries.ts`
- Test: `app/src/data/queries.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/data/queries.test.ts`, add `describe("categoryBudgets")`. Use the fixture helpers of the file. The fixture has `time_period = "monthly"`, the categories Food and Transport (expense) and Salary (income), and a range of 2026-10-01 to 2026-10-31. Cases:

1. "returns the spent amount of each category budget": Food budget 50000 monthly, Food expenses of 30000 and 11020 in the range and one of 9999 on 2026-09-30. Assert one row `{ category_id: foodId, amount_minor: 50000, spent_minor: 41020 }`.
2. "counts all accounts": expenses of Food on two accounts. Assert `spent_minor` is the sum of both.
3. "ignores budgets of another period": a weekly Food budget only. Assert no rows.
4. "ignores the overall budget": a budget with `category_id` null. Assert no rows.
5. "ignores archived categories": an archived category with a budget. Assert no row for it.
6. "a budget with no expenses has spent 0": Transport budget 15000 and no Transport expenses. Assert `spent_minor` is `0`.
7. "follows Hide Future": with `hide_future = 1`, a Food expense after `today` does not count. With `hide_future = 0` it counts. Use the same `today` parameter that the `categoryTotals` tests use.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- queries.test.ts -t categoryBudgets`
Expected: FAIL, `categoryBudgets` is not exported.

- [ ] **Step 3: Write the implementation**

In `app/src/data/queries.ts`, add `export interface CategoryBudget { budget_id: string; category_id: string; amount_minor: number; spent_minor: number }` and `export function categoryBudgets(range: Period, today: string): SqlQuery`. The SQL selects from `budgets b`, joins `user_settings s ON s.time_period = b.period` and `categories c ON c.id = b.category_id AND c.archived_at IS NULL`, and has `b.category_id IS NOT NULL`. `spent_minor` is a subquery with `COALESCE(SUM(t.amount_minor), 0)` over `transactions t` with `t.type = 'expense' AND t.category_id = b.category_id AND t.date BETWEEN ? AND ?` and the existing `visible` fragment, as in `budgetProgress`. Order by `c.sort_order, c.name, b.id`.

Add the hook `useCategoryBudgets(range: Period)` next to `useBudgetProgress`, with `useRows` and `localToday()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- queries.test.ts`
Expected: PASS.

---

### Task 3: Budget field in the category form

**Files:**
- Modify: `app/src/ui/screens/Categories.tsx` (`CategoryForm` and `CategoryFormBody`)
- Test: `app/src/ui/screens/CategoriesAccounts.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/ui/screens/CategoriesAccounts.test.tsx`, add `describe("category budget")`, with the mocks and fixtures that the file already uses for `CategoryForm`. Cases:

1. "shows the Budget field for an expense category": render the form for Food. Assert a text input with the accessibility label "Monthly budget" (the label uses the `time_period` setting: "Daily budget", "Weekly budget", "Biweekly budget", "Monthly budget" or "Yearly budget") and the note "Empty means no budget."
2. "hides it for an income category": render the form for Salary, and a new form after a switch to Income. Assert there is no "Monthly budget" input.
3. "shows the stored amount": with a Food budget of 50000 monthly, assert the input shows `500.00` (use `amountInputText` for the expected text).
4. "save writes the budget": type `150` in the input of the Transport form, press Save. Assert one `budgets` row for Transport with `amount_minor = 15000` and `period = "monthly"`, and that `onClose` was called.
5. "an empty field deletes the budget": with a Food budget, clear the input and press Save. Assert there is no Food budget row.
6. "an invalid amount blocks the save": type `abc`. Assert the field shows "Invalid amount" and the Save button is disabled.
7. "a new category with a budget": fill in a new expense category with a budget of 80, and save. Assert the category and its budget row exist.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- CategoriesAccounts.test.tsx -t "category budget"`
Expected: FAIL, no "Monthly budget" input.

- [ ] **Step 3: Write the implementation**

In `CategoryForm`, read the stored budget with `useQuery` (`SELECT amount_minor FROM budgets WHERE category_id = ? AND period = ? ORDER BY id LIMIT 1`, with the category id and `settings.time_period`). Wait for it in the existing loading check, and pass `storedBudget: number | null`, `currency` and `timePeriod` to `CategoryFormBody`.

In `CategoryFormBody`:
- Add state `budgetText`, which starts from `amountInputText(storedBudget, currency)` or `""`.
- Parse it with `parseAmount(budgetText, currency)`. An empty text means `null`. A text that does not parse adds an error, so `canSave` is false, and the field shows "Invalid amount".
- Render a new `FormField` after "Colour", only when `type === "expense"`. Its label is `${periodTitle} budget`, where `periodTitle` is `timePeriod` with a capital first letter. Below the input, show the note "Empty means no budget. The period is the Time Period from Settings." in `theme.accent`.
- In `save`, call `saveCategory` as today. If it succeeds and the type is `expense`, call `saveCategoryBudget(db, result.id, timePeriod, budget)` when the parsed value differs from `storedBudget`. If the type changed to income and a budget exists, call it with `null`. Both calls are skipped when nothing changed.

The two calls run in two transactions. This is acceptable: if the second call fails, the form shows "Could not save. Try again." through the existing `run` helper, and a second save writes only the budget.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- CategoriesAccounts.test.tsx`
Expected: PASS.

---

### Task 4: Budget bars on the chalkboard

**Files:**
- Modify: `app/src/ui/screens/Chalkboard.tsx`
- Test: `app/src/ui/screens/Chalkboard.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/ui/screens/Chalkboard.test.tsx`, add `describe("category budgets")` with the existing mocks. Mock `useLayoutMode` from `app/src/hooks/useLayoutMode` so a test can choose `"tabs"` or `"sidebar"`. Cases:

1. "shows the bar and the rest under a budgeted line": Food budget 50000, spent 41020, layout `tabs`. Assert an element with testID `category-budget-bar` inside the Food line group, its fill width is `82%`, and the text "of 500.00 · 89.80 left".
2. "shows over budget in red": Restaurants budget 18000, spent 21200. Assert the text "of 180.00 · 32.00 over" with color `theme.chalkRed`, and a fill width of `100%`.
3. "no bar for a category with no budget": assert Rent has no `category-budget-bar`.
4. "wide layout shows the budget on the line": layout `sidebar`. Assert the Food line shows " / 500.00" and no "left" text, and the bar is still there.
5. "no bars for one account": press "Next account". Assert there is no `category-budget-bar`.
6. "the accessibility label includes the budget": assert the Food line's label is "Food, 410 euro 20, budget 500 euro" (use `spokenAmount` for both parts).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- Chalkboard.test.tsx -t "category budgets"`
Expected: FAIL, no `category-budget-bar`.

- [ ] **Step 3: Write the implementation**

In `Chalkboard`, call `useCategoryBudgets(period)` and build a map from `category_id` to the row. Read `useLayoutMode() === "sidebar"` as `wide`.

In `categoryLine`, for expense lines when `account` is null and the map has the category:
- Wide: pass the amount as `${format(row.total)} / ${format(budget.amount_minor)}` to `Line`, with the " / ..." part in a smaller grey chalk text (`fontSize` 11, color `#bdbdb5`).
- Phone: after `Line`, render a `Text` with "of X · Y left" or "of X · Y over" in chalk text, `fontSize` 11, `paddingLeft` 18. Use `theme.chalkRed` for "over".
- Both: render a `View` with testID `category-budget-bar`: height 5, border 1 px of `CHALK_WHITE` at 70% opacity, radius 4, `marginLeft` 18, and a fill `View` with width `min(1, spent / amount) * 100%` in `theme.chalkRed`.
- Add ", budget <spokenAmount>" to the accessibility label.

Keep the bar inside the `Pressable` of the line, so a tap on the bar still opens the category.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- Chalkboard.test.tsx`
Expected: PASS.

---

### Task 5: Web e2e test

**Files:**
- Create: `e2e/web/category-budgets.spec.ts`
- Type: frontend

- [ ] **Step 1: Write the test**

In `e2e/web/category-budgets.spec.ts`, use `test`, `newUser`, `logIn`, `goToPage`, `addTransaction` and `waitForSynced` from `e2e/web/fixtures.ts`. One test, "set a category budget and see its progress":

1. Log in as a new user. Open Categories (`goToPage`, key 3) and open the seeded expense category "Groceries" (`api/internal/users/seed.go`).
2. Type `100` in "Monthly budget" and save.
3. Add an expense of 25 in that category with `addTransaction`.
4. Open Spending. Assert the text "of 100.00 · 75.00 left" is visible (the default viewport of the config is the phone layout; if it is the wide layout, assert " / 100.00" instead).
5. Call `waitForSynced`, then assert with `query()` from `e2e/support/db.ts` that `budgets` has one row for the user with the category id, `period = 'monthly'` and `amount_minor = 10000`.

- [ ] **Step 2: Run the test**

Run: `make e2e-stack-up && make e2e-web`
Expected: PASS on chromium, firefox and webkit, including the new spec.

---

### Task 6: Full check

- [ ] **Step 1: Run all app tests, lint and types**

Run: `npm --workspace app test && npm --workspace app run lint && npm --workspace app run typecheck`
Expected: all pass, no errors.

- [ ] **Step 2: Manual check on iOS**

Start the app on the iPhone simulator. Set a budget for one category, add expenses, and check the bar and the "left" and "over" texts on the chalkboard in the light and dark themes.
