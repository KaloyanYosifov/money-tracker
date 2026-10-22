# Spending Tracker Backup Import Implementation Plan

**Goal:** Import a Spending Tracker SQLite backup into Money Tracker with a shared TypeScript parser and a Node script that writes through the upload API.

**Architecture:** A pure parser in `app/src/import/spendingTracker/` changes the five backup tables into upload ops and a list of problems. A Node script reads the backup with `node:sqlite`, logs in, reads the existing accounts and categories from a new `GET /api/import/existing` endpoint, writes an editable `mapping.json`, and on the second run uploads the ops to `POST /api/sync/upload`. Accounts get a new `opening_balance_minor` field that Carry Over includes.

**Tech Stack:** TypeScript (Expo app, Jest with `better-sqlite3`), Node 26 (`node:sqlite`, type stripping), Go API (`net/http`, pgx, goose, testcontainers), JSON Schema with `make generate`.

---

## Context

The backup is the native SQLite file of Spending Tracker. It has these tables:

| Table | Columns that the import uses |
|---|---|
| `Profile` | `Id`, `Name`, `Colour` (hex without `#`, often empty) |
| `Category` | `Id`, `Name`, `Type` (`Expense`, `Income`, `Transfer`, `Carry`), `Icon` (for example `80-shopping-cart`), `Colour` |
| `Transaction` | `Id`, `Type` (`Expense`, `Income`, `Transfer`), `Date` (.NET ticks), `Amount` (float), `Note`, `ProfileId`, `CategoryId`, `RecurringTransactionId` |
| `RecurringTransaction` | `Id`, `Type`, `Date` (start, ticks), `EndDate` (ticks or null), `Amount`, `Note`, `RecurringType` (`Monthly`, ...), `RecurringPeriod`, `ProfileId`, `CategoryId` |

`Strategy` is not imported. All budget amounts in it are 0.

Rules that the brainstorm agreed:

- A .NET tick is 100 ns since 0001-01-01. Date = UTC date of `(ticks - 621355968000000000) / 10000` milliseconds since the Unix epoch. `638408736000000000` is `2024-01-15`.
- Amount in minor units = `Math.round(Math.abs(Amount) * 10 ** minorUnits(currency))`. An expense or income with a negative or zero amount is a problem and is skipped.
- A transfer is two rows: negative amount on the source profile, positive on the target. They become one `transfer` row.
- The earliest row in the `Carry` category of each account is an opening balance. `mapping.json` lists their source IDs, and the user edits the list. The parser never reads the note text. Other `Carry` rows become income in the category that the mapping gives for the `Carry` category.
- Rules are imported. A linked row on the schedule of its rule gets the ID `occurrenceId(ruleId, date)`, `source: "recurring"` and `recurring_rule_id`. This includes rows after today, as in Spending Tracker. `generateDue()` skips an occurrence ID that exists, and the "Hide Future Transactions" setting hides these rows. Other linked rows import as normal rows.
- All other IDs are UUIDv5 from a fixed import namespace and a key such as `st:transaction:101`. A second run updates the same rows.
- Out of scope: the in-app import UI (step 2) and the change to `expense-tracker-spec.md` section 7 that step 2 needs.

Do not commit a real backup file or a real `mapping.json`. They have personal data. Add `mapping.json` to `.gitignore` in Task 11.

## File Structure

| File | Responsibility |
|---|---|
| `schema/account.schema.json`, `schema/version.json` | New optional `opening_balance_minor` field, schema version 2 |
| `api/internal/db/migrations/00004_account_opening_balance.sql` | New column in PostgreSQL |
| `app/src/data/schema.ts` | New column in the local PowerSync schema |
| `app/src/data/queries.ts` | Carry Over adds the opening balance |
| `app/src/domain/money.ts`, `app/src/domain/validation.ts`, `app/src/data/mutations.ts`, `app/src/ui/screens/Accounts.tsx` | Opening balance in the account form |
| `app/src/ui/palette.ts` | `PALETTE` in a module with no React Native imports, so Node can load it |
| `api/internal/sync/existing.go`, `api/internal/httpserver/server.go` | `GET /api/import/existing` |
| `app/src/import/spendingTracker/types.ts` | Source row types, mapping type, plan and problem types |
| `app/src/import/spendingTracker/convert.ts` | Ticks, amounts, IDs, icons, colours, text |
| `app/src/import/spendingTracker/mapping.ts` | `proposeMapping` and `validateMapping` |
| `app/src/import/spendingTracker/plan.ts` | `buildPlan` |
| `app/src/import/spendingTracker/index.ts` | Public exports |
| `scripts/import-spending-tracker.ts` | The CLI: read, log in, map, confirm, upload |

The parser files import other app files with an explicit `.ts` extension and use `import type` for types. Then `node scripts/import-spending-tracker.ts` loads them with Node type stripping, and Metro and Jest still resolve them. The parser imports only `uuid`, `../../domain/ids.ts`, `../../domain/recurrence.ts`, `../../domain/money.ts` and `../../ui/palette.ts`. It must not import any file that imports React Native.

---

### Task 1: Opening balance field in the schema and the database

**Files:**
- Modify: `schema/account.schema.json`
- Modify: `schema/version.json`
- Create: `api/internal/db/migrations/00004_account_opening_balance.sql`
- Modify: `app/src/data/schema.ts:6-12`
- Generated: `app/src/generated/schema.ts`, `api/internal/schema/types_gen.go`, `api/internal/schema/json/`
- Test: `api/internal/sync/apply_test.go`
- Type: both

- [ ] **Step 1: Write the failing test**

In `api/internal/sync/apply_test.go`, add `TestApplyAccountOpeningBalance`. Use the existing fixture helpers of the file. Apply a `PUT` on `accounts` with `name`, `color`, `sort_order` and `opening_balance_minor: -5000`. Assert the result is `Applied` and that `SELECT opening_balance_minor FROM accounts WHERE id = $1` returns `-5000`. Then apply a `PUT` for a second account with no `opening_balance_minor` and assert the column is `0`. Then apply a `PATCH` with only `name` to the first account and assert `opening_balance_minor` is still `-5000`. Last, apply a `PUT` with `opening_balance_minor: 1000000000001` and assert the result is `Rejected` with code `invalid_record`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go -C api test ./internal/sync/ -run TestApplyAccountOpeningBalance -v`
Expected: FAIL. The op is rejected with `invalid_record`, because the schema does not allow `opening_balance_minor`.

- [ ] **Step 3: Change the schema and add the migration**

1. In `schema/account.schema.json`, add the property `opening_balance_minor`: type `integer`, `minimum` -1000000000000, `maximum` 1000000000000, `default` 0. Do not add it to `required`, so uploads from older app builds stay valid.
2. In `schema/version.json`, set `schemaVersion` to 2. Keep `minSupportedSchemaVersion` at 1.
3. Run `make generate`.
4. Create `api/internal/db/migrations/00004_account_opening_balance.sql` in the goose format of `00003_sync_access.sql`. Up: `ALTER TABLE accounts ADD COLUMN opening_balance_minor bigint NOT NULL DEFAULT 0 CHECK (opening_balance_minor BETWEEN -1000000000000 AND 1000000000000)`. Down: drop the column.
5. In `app/src/data/schema.ts`, add `opening_balance_minor: column.integer` to the `accounts` table.

`sync/sync-rules.yaml` uses `SELECT *`, so PowerSync sends the new column with no change. The `tables` map in `api/internal/sync/tables.go` reads the columns from the generated Go type, so it also needs no change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/sync/ ./internal/db/ ./internal/schema/ -v`
Expected: PASS, with `TestApplyAccountOpeningBalance` in the list.

Run: `make check-generated`
Expected: exit code 0, no diff.

Run: `npm --workspace app test -- src/data/schema.test.ts`
Expected: PASS.

---

### Task 2: Carry Over includes the opening balance

**Files:**
- Modify: `app/src/data/queries.ts:77-88`
- Test: `app/src/data/queries.test.ts:164-178`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/data/queries.test.ts`, in `describe("carryOver")`:

1. Add `it("adds the opening balance of the account")`. Set `opening_balance_minor` of the `wallet` account in the fixture to `10000` (with an `UPDATE` in the test). Assert `carryOver(october.start, ["wallet"], today)` returns the wallet balance of the first existing test plus 10000, so `43000 + 10000 = 53000`.
2. Add `it("shows an opening balance for an account with no rows")`. Set `opening_balance_minor` of `empty` to `-2500`. Assert the `empty` row has `balance: -2500`.

In `describe("transactionList")`, add `it("shows a Carry Over row for an account with only an opening balance")`. Set `opening_balance_minor` of `empty` to `-2500`. Assert the list for `october` has a row with `kind: "carryOver"`, `account_id: "empty"`, `type: "expense"` and `amount_minor: 2500`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/data/queries.test.ts`
Expected: FAIL. The balances do not include the opening balance.

- [ ] **Step 3: Implement**

In `app/src/data/queries.ts`, add a third branch to the `UNION ALL` in `balancesCte`: select `a.id` and `a.opening_balance_minor` from `accounts a` where `a.opening_balance_minor <> 0`. The branch has no parameters, so the parameter lists of `carryOver` and `transactionList` stay the same. Update the comment above `balancesCte` so it names the opening balance. Rows with a null `opening_balance_minor` (the existing test fixtures) are left out by the `<> 0` condition.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/data/queries.test.ts`
Expected: PASS.

---

### Task 3: Opening balance in the account form

**Files:**
- Modify: `app/src/domain/money.ts`
- Modify: `app/src/domain/validation.ts:52-57`, `app/src/domain/validation.ts:146-151`
- Modify: `app/src/data/mutations.ts:169-182`
- Modify: `app/src/ui/screens/Accounts.tsx:140-215`
- Test: `app/src/domain/money.test.ts`, `app/src/data/mutations.test.ts`, `app/src/ui/screens/CategoriesAccounts.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

1. In `app/src/domain/money.test.ts`, add tests for a new `parseSignedAmount(text, currency, locale?)`:
   - `"12.50"` gives `1250`. `"-12.50"` gives `-1250`. `"-12,50"` with locale `de` gives `-1250`.
   - `""`, `"0"` and `"-0"` give `0`.
   - `"abc"`, `"1.234"` (too many fraction digits for EUR) and `"-"` give `null`.
   - `"10000000000.01"` gives `null` (above `MAX_AMOUNT_MINOR`).
2. In `app/src/data/mutations.test.ts`, add a test for `saveAccount` with `opening_balance_minor: -5000`. Assert the stored row has `opening_balance_minor` `-5000`. Add a test where `opening_balance_minor` is `1.5` and assert the result is `{ ok: false }` with an error on field `opening_balance_minor`.
3. In `app/src/ui/screens/CategoriesAccounts.test.tsx`, add a test: open the new account form, type a name, type `-25.00` in the field with the label "Opening balance", save, and assert `saveAccount` received `opening_balance_minor: -2500`. Add a test that typing `abc` shows the error text "Not a valid amount" and disables Save.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/domain/money.test.ts src/data/mutations.test.ts src/ui/screens/CategoriesAccounts.test.tsx`
Expected: FAIL. `parseSignedAmount` does not exist, and the form has no "Opening balance" field.

- [ ] **Step 3: Implement**

1. `money.ts`: add `parseSignedAmount`. Trim the text. An empty string gives `0`. If the text starts with `-`, remove it and remember the sign. Parse the rest with the same normalisation as `parseAmount`, but accept 0. Return the signed value, or `null` when the rest does not parse or is above `MAX_AMOUNT_MINOR`. Reuse `decimalToMinor` and the separator logic. Do not change `parseAmount`.
2. `validation.ts`: add `opening_balance_minor?: number` to `AccountInput`. In `validateAccount`, if the value is defined and is not an integer, or its absolute value is above `MAX_AMOUNT_MINOR`, add an error with field `opening_balance_minor`. The code is `invalid` for a value that is not an integer and `out_of_range` for a value that is too large.
3. `mutations.ts`: in `saveAccount`, add `opening_balance_minor` to `values` when it is defined.
4. `Accounts.tsx`: in the account form, add a `FormField` with the label "Opening balance" after "Name". Its `TextInput` starts with `amountInputText(existing.opening_balance_minor, currency)` for an account with a non-zero value, else empty. Show a `-` for a negative value. Use `keyboardType="numbers-and-punctuation"` so the user can type a minus sign. Get the currency the same way as `TransactionForm.tsx` does: `userSettings?.currency_code ?? "EUR"`. Pass `parseSignedAmount(text, currency)` as `opening_balance_minor` in `input`. If it returns `null`, show "Not a valid amount" and disable Save.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/domain/money.test.ts src/data/mutations.test.ts src/ui/screens/CategoriesAccounts.test.tsx`
Expected: PASS.

Run: `npm --workspace app run typecheck`
Expected: no errors.

---

### Task 4: Move PALETTE to a module that Node can load

**Files:**
- Create: `app/src/ui/palette.ts`
- Modify: `app/src/ui/screens/manage.tsx:37-51`
- Type: frontend

- [ ] **Step 1: Move the constant**

Create `app/src/ui/palette.ts` with the `PALETTE` constant and its doc comment, moved from `manage.tsx`, with no change to the values. In `manage.tsx`, import `PALETTE` from `../palette` and re-export it, so `Accounts.tsx` and `Categories.tsx` need no change.

- [ ] **Step 2: Run the tests to verify nothing changed**

Run: `npm --workspace app test -- src/ui/screens`
Expected: PASS.

Run: `npm --workspace app run typecheck`
Expected: no errors.

---

### Task 5: GET /api/import/existing

**Files:**
- Create: `api/internal/sync/existing.go`
- Create: `api/internal/sync/existing_test.go`
- Modify: `api/internal/httpserver/server.go:36`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `api/internal/sync/existing_test.go` (package `sync_test`), use `testutil.StartPostgres` and an environment like `newUploadEnv` in `handler_test.go`, with the handler `h.RequireUser(sync.NewExistingHandler(pool, logger))`. Insert two users. For user A, insert a `user_settings` row with `currency_code` `EUR`, two accounts (one archived, one with `opening_balance_minor` 1500) and two categories (one expense, one income). For user B, insert one account and one category.

1. `TestExistingReturnsOwnRecords`: `GET` as user A. Assert status 200 and a JSON body `{ "currency_code": "EUR", "accounts": [...], "categories": [...] }`. Each account has `id`, `name`, `sort_order`, `opening_balance_minor` and `archived` (bool). Each category has `id`, `name`, `type`, `sort_order` and `archived`. Assert the lists have exactly the rows of user A, ordered by `sort_order`, then `name`.
2. `TestExistingUnauthorized`: `GET` with no token returns 401.
3. `TestExistingNoSettings`: `GET` as a user with no `user_settings` row returns 200 with `currency_code` `""` and empty lists, not `null`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/sync/ -run TestExisting -v`
Expected: FAIL to compile, because `sync.NewExistingHandler` does not exist.

- [ ] **Step 3: Implement**

In `api/internal/sync/existing.go`, add `NewExistingHandler(pool *pgxpool.Pool, logger *slog.Logger) http.Handler`. It reads the user ID with `auth.UserID(r.Context())` and runs three queries, each filtered by `user_id`. On a database error it logs the error and writes 503 with `{ "error": "unavailable" }`, the same as the upload handler. On success it writes the body from Step 1 with `writeJSON`. Initialise both lists as empty slices.

In `api/internal/httpserver/server.go`, after the upload route, add `mux.Handle("GET /api/import/existing", authHandlers.RequireUser(sync.NewExistingHandler(pool, logger)))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/sync/ ./internal/httpserver/ -v`
Expected: PASS.

---

### Task 6: Parser types and conversions

**Files:**
- Modify: `app/tsconfig.json`
- Create: `app/src/import/spendingTracker/types.ts`
- Create: `app/src/import/spendingTracker/convert.ts`
- Create: `app/src/import/spendingTracker/index.ts`
- Test: `app/src/import/spendingTracker/convert.test.ts`
- Type: frontend

- [ ] **Step 1: Add the types**

1. In `app/tsconfig.json`, add `"allowImportingTsExtensions": true` to `compilerOptions`. The Expo base already sets `noEmit`.
2. In `types.ts`, define:
   - `SourceProfile`, `SourceCategory`, `SourceTransaction`, `SourceRecurring`: one type for each table, with the column names and types from the Context table. Nullable columns are `| null`.
   - `SourceData`: `{ profiles, categories, transactions, recurring }`, one array for each.
   - `Existing`: the response body of `GET /api/import/existing`.
   - `Mapping`: `{ currency: string; accounts: Record<string, AccountEntry>; categories: Record<string, CategoryEntry>; opening_balances: number[]; rows_without_account: { action: "skip" } | { action: "match"; target: string } }`. `AccountEntry` is `{ name; action: "create" | "match" | "skip"; target?; color?; reason? }`. `CategoryEntry` is `{ name; type: "expense" | "income" | "transfer"; action; target?; icon?; color?; reason? }`. The keys are the source IDs as strings.
   - `Problem`: `{ kind; sourceIds: number[]; message: string }`. `kind` is one of `unpaired_transfer`, `no_account`, `same_account_transfer`, `invalid_amount`, `unsupported_recurrence`, `missing_occurrence`.
   - `UploadOp`: `{ op: "PUT" | "PATCH"; table: "accounts" | "categories" | "recurring_rules" | "transactions"; id: string; data: Record<string, unknown> }`.
   - `ImportPlan`: `{ ops: UploadOp[]; problems: Problem[]; counts: Record<string, number> }`. The keys of `counts` are `accounts`, `categories`, `recurring_rules`, `transactions`, `transfers`, `occurrences`.

- [ ] **Step 2: Write the failing tests**

In `convert.test.ts`:

1. `ticksToDate(638408736000000000)` returns `"2024-01-15"`. `ticksToDate(638763840000000000)` returns `"2025-03-01"`. A tick value of 23:59:59 on 2024-01-15 returns `"2024-01-15"`.
2. `toMinor(12.3399999, "EUR")` returns `1234`. `toMinor(-50, "EUR")` returns `5000`. `toMinor(0.004, "EUR")` returns `0`.
3. `importId("transaction", 101)` returns the same UUID on two calls, and a different UUID from `importId("account", 101)`. It matches the UUID version 5 pattern.
4. `iconFor("80-shopping-cart")` returns `"cart"`, `iconFor("48-fork-and-knife")` returns `"fork"` and `iconFor("unknown-icon")` returns `"tag"`. Every value of the icon table is in `categoryIconKeys` from `app/src/ui/icons/categoryIcons.tsx` (only the test imports that file).
5. `colorFor("AABBCC", 3)` returns `"#AABBCC"`. `colorFor("", 3)` and `colorFor(null, 3)` return `PALETTE[3 % PALETTE.length].hex`. `colorFor("zz", 0)` returns `PALETTE[0].hex`.
6. `splitNote("  Coffee beans ")` returns `{ name: "Coffee beans", note: null }`. A 127-character note returns a `name` of 120 characters and the full trimmed text as `note`. `null` returns `{ name: "", note: null }`.
7. `cleanName("Pet food ")` returns `"Pet food"`. `sameName("Eating out", " eating Out")` returns `true`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/import/spendingTracker`
Expected: FAIL. The functions do not exist.

- [ ] **Step 4: Implement**

In `convert.ts`, implement the functions from Step 2:

- `ticksToDate`: use `BigInt` for the tick math, because the values are above `Number.MAX_SAFE_INTEGER`. Return the UTC date as `YYYY-MM-DD`.
- `toMinor(amount, currency)`: `Math.round(Math.abs(amount) * 10 ** minorUnits(currency))`. Import `minorUnits` from `../../domain/money.ts`.
- `importId(kind, sourceId)`: `v5("st:" + kind + ":" + sourceId, IMPORT_NAMESPACE)`. Generate `IMPORT_NAMESPACE` one time with `uuid v4` and put it in the file as a constant, with a comment that it must never change.
- `iconFor(stIcon)`: a constant table for these keys, with `tag` as the fallback: `80-shopping-cart` cart, `67-tshirt` shirt, `48-fork-and-knife` fork, `76-baby` baby, `24-gift` gift, `47-fuel` car, `37-suitcase` plane, `15-bus` bus, `31-ipod` music, `63-runner` sport, `172-pricetag` tag, `119-piggy-bank` piggy, `125-food` groceries, `33-cabinet` home, `161-calculator` calculator, `96-book` book, `gas` flame, `237-key` key, `185-printer` tax, `tax` tax, `154-necktie` shirt, `178-city` home.
- `colorFor(stColour, index)`: if the value matches `^[0-9a-fA-F]{6}$`, prefix `#`. Else use the palette colour. Import `PALETTE` from `../../ui/palette.ts`.
- `splitNote`, `cleanName` (trim, then the first 60 characters) and `sameName` (compare `cleanName` of both in lower case).

In `index.ts`, re-export the types and the public functions. Later tasks add `proposeMapping`, `validateMapping` and `buildPlan`.

All relative imports in the parser use the `.ts` extension. Type imports use `import type`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/import/spendingTracker`
Expected: PASS.

Run: `node -e "import('./app/src/import/spendingTracker/index.ts').then(m => console.log(Object.keys(m).length > 0))"`
Expected: `true`. Node loads the parser with no bundler.

---

### Task 7: proposeMapping and validateMapping

**Files:**
- Create: `app/src/import/spendingTracker/mapping.ts`
- Modify: `app/src/import/spendingTracker/index.ts`
- Create: `app/src/import/spendingTracker/fixtures.ts`
- Test: `app/src/import/spendingTracker/mapping.test.ts`
- Type: frontend

- [ ] **Step 1: Write the fixture**

In `fixtures.ts`, export a function `sourceFixture(): SourceData` with small synthetic rows. Do not copy real notes or amounts from the backup. It has:
- Profiles 2 "Bank A" (colour `AABBCC`), 3 "Card B", 4 "Cash" (no colour), 1 "Default" (no transactions).
- Categories 4 "Eating Out" (Expense), 14 "Transfer" (Transfer), 15 "Carry Over" (Carry), 25 "Pet food " (Expense, trailing space), 30 "Sale" (Expense), 31 "Sale" (Income), 1 "Salary" (Income), 5 "Kids" (Expense, no transactions).
- Transactions that cover each rule of Task 8, Task 9 and Task 10. Each test file adds or changes rows for its own cases.

Also export `existingFixture(): Existing` with the seeded rows: accounts "Wallet" and "Bank", categories "Eating Out" (expense), "Salary" (income), "Other income" (income), "Rent" (expense), with `currency_code` `EUR`.

- [ ] **Step 2: Write the failing tests**

In `mapping.test.ts`:

1. `proposeMapping(source, existing)`:
   - `currency` is `existing.currency_code`, or `"EUR"` when it is empty.
   - Account 2 is `{ name: "Bank A", action: "create", color: "#AABBCC" }`. Account 1 is `skip` with `reason` `"0 transactions"`.
   - Category 4 is `match` with `target: "Eating Out"`. Category 25 is `create` with `name: "Pet food"` and `icon: "cart"`. Category 30 is `create` with type `expense`, and category 31 is `create` with type `income`. Category 5 is `skip` with `reason` `"0 transactions"`.
   - Category 14 is `skip` with type `transfer` and `reason` `"transfers have no category"`.
   - Category 15 is `match` with type `income` and `target: "Other income"`. If `existing` has no "Other income", it is `create` with `name: "Other income"`.
   - A match ignores archived existing rows.
   - `opening_balances` has the ID of the earliest `Carry` row of each profile. If two rows have the same date, it takes the lower ID.
   - `rows_without_account` is `{ action: "skip" }`.
2. `validateMapping(source, mapping, existing)` returns a list of error strings:
   - Empty list for the proposed mapping.
   - An error for a `match` target that does not exist, for an archived target, and for a category target of the wrong type.
   - An error when two existing non-archived rows match one target name.
   - An error for an account or a non-transfer category with `skip` when transactions or rules use it. The message gives the count.
   - An error for an ID in `opening_balances` that is not a `Carry` row.
   - An error for a `currency` that does not match `^[A-Z]{3}$`.
   - An error when `rows_without_account.target` does not exist.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/import/spendingTracker/mapping.test.ts`
Expected: FAIL. The functions do not exist.

- [ ] **Step 4: Implement**

In `mapping.ts`, implement `proposeMapping` and `validateMapping` with the behaviour from Step 2. Use `sameName` for all name matches, together with the type for categories. Map the source type `Expense` to `expense`, `Income` and `Carry` to `income`, and `Transfer` to `transfer`. Export both from `index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/import/spendingTracker/mapping.test.ts`
Expected: PASS.

---

### Task 8: buildPlan for accounts, categories and opening balances

**Files:**
- Create: `app/src/import/spendingTracker/plan.ts`
- Modify: `app/src/import/spendingTracker/index.ts`
- Test: `app/src/import/spendingTracker/plan.test.ts`
- Type: frontend

`buildPlan(source, mapping, existing, options)` takes `options = { userId: string; importBatchId: string; today: string }`. It expects a mapping that `validateMapping` accepted.

- [ ] **Step 1: Write the failing tests**

In `plan.test.ts`, in `describe("accounts and categories")`:

1. A `create` account gives one `PUT` on `accounts` with `id: importId("account", 7)`, `user_id`, `name`, `color` and `sort_order`. New accounts get `sort_order` values after the highest existing `sort_order`, in source ID order.
2. A `match` account gives no `PUT`. Its source rows use the existing account ID.
3. A `skip` account gives no op.
4. Categories follow the same rules. A created category has `type`, `icon` and `color` from the mapping entry. A `transfer` category gives no op.
5. Opening balances: two `Carry` rows on profile 2 in `opening_balances` (100.00 and 5.00) give `opening_balance_minor: 10500` on the `PUT` for account 2. For a `match` account, the plan adds one `PATCH` on `accounts` with the existing ID and only `opening_balance_minor`.
6. The ops are in this order: all accounts, then categories, then recurring rules, then transactions.
7. Two calls of `buildPlan` with the same input return deep-equal plans.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/import/spendingTracker/plan.test.ts`
Expected: FAIL. `buildPlan` does not exist.

- [ ] **Step 3: Implement**

In `plan.ts`, implement `buildPlan` for accounts, categories and opening balances. Build two lookup maps, source profile ID to account ID and source category ID to category ID, for Task 9 and Task 10. Resolve `match` targets to IDs with `sameName` against `existing`. Fill `counts.accounts` and `counts.categories` with the number of `PUT` ops. Export `buildPlan` from `index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/import/spendingTracker/plan.test.ts`
Expected: PASS.

---

### Task 9: buildPlan for transactions and transfers

**Files:**
- Modify: `app/src/import/spendingTracker/plan.ts`
- Test: `app/src/import/spendingTracker/plan.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `plan.test.ts`, in `describe("transactions")`:

1. An expense row gives a `PUT` on `transactions` with `id: importId("transaction", id)`, `type: "expense"`, `amount_minor`, `currency_code` from the mapping, `date`, `name` and `note` from `splitNote`, the mapped `category_id` and `account_id`, `to_account_id: null`, `recurring_rule_id: null`, `source: "import"`, `import_batch_id` and `external_id: "st:" + id`.
2. A `Carry` row that is not in `opening_balances` gives an `income` row in the category that the mapping gives for the `Carry` category. A `Carry` row in `opening_balances` gives no transaction.
3. Transfer rows 201 (-50.00, profile 3) and 202 (50.00, profile 2) on the same date give one row: `type: "transfer"`, `account_id` of profile 3, `to_account_id` of profile 2, `amount_minor: 5000`, `category_id: null`, `id: importId("transfer", 201)`, `external_id: "st:201+202"`. `counts.transfers` is 1.
4. A transfer row with no partner (the next ID has another date, the same sign, or the same profile) gives a problem `unpaired_transfer` with its ID, and no op. Pairing works from the lowest ID up. Row N pairs only with row N+1.
5. A transfer where both profiles map to the same account gives a problem `same_account_transfer` and no op.
6. A row with no `ProfileId` gives a problem `no_account` when `rows_without_account` is `skip`. With `{ action: "match", target: "Wallet" }`, it imports with the ID of the seeded Wallet account. A transfer half with no profile is always `unpaired_transfer`.
7. An expense or income with amount 0 or below, or an amount that rounds to 0, gives a problem `invalid_amount` and no op.
8. Every transaction op passes `validateTransaction` from `app/src/domain/validation.ts`, with the category type of its category. Run this check in a loop over all ops of the fixture plan.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/import/spendingTracker/plan.test.ts`
Expected: FAIL in `describe("transactions")`.

- [ ] **Step 3: Implement**

In `plan.ts`, add the transaction step. Process rows by ascending ID. Skip rows that Task 10 handles (rows with a `RecurringTransactionId` of a rule that the plan imports). Fill `counts.transactions` and `counts.transfers`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/import/spendingTracker/plan.test.ts`
Expected: PASS.

---

### Task 10: buildPlan for recurring rules and occurrences

**Files:**
- Modify: `app/src/import/spendingTracker/plan.ts`
- Test: `app/src/import/spendingTracker/plan.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `plan.test.ts`, in `describe("recurring")`, with `today` `2026-10-22`:

1. A rule with `RecurringType` `Monthly`, `RecurringPeriod` 1, start 2026-07-31 and no end date gives a `PUT` on `recurring_rules` with `id: importId("rule", id)`, `frequency: "monthly"`, `start_date: "2026-07-31"`, `end_date: null`, and `name`, `note`, `amount_minor`, `category_id`, `account_id` and `type` from the rule.
2. The frequency table: `Daily`/1 is `daily`, `Weekly`/1 is `weekly`, `Weekly`/2 is `biweekly`, `Monthly`/1 is `monthly`, `Yearly`/1 is `yearly`. Any other pair, or a rule of type `Transfer`, gives a problem `unsupported_recurrence` and no rule op. Its linked rows then import as normal rows by the Task 9 rules.
3. Linked rows on 2026-07-31, 2026-08-31 and 2026-09-30 get `id: occurrenceId(ruleId, date)`, `source: "recurring"` and `recurring_rule_id: ruleId`. `counts.occurrences` is 3.
4. A linked row on 2026-10-31 (after today) also gets `id: occurrenceId(ruleId, date)`. `counts.occurrences` is then 4. A linked row after today that is not on the schedule imports as a normal row.
5. A linked row on a past date that is not in `occurrenceDates(rule, today)`, for example 2026-08-15, imports as a normal row with `importId("transaction", id)` and `recurring_rule_id: null`.
6. A past date in `occurrenceDates(rule, today)` with no linked row gives a problem `missing_occurrence` with the rule ID and the date in the message. The message says that the generator creates a row for that date.
7. Every rule op passes `validateRecurringRule` from `app/src/domain/validation.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/import/spendingTracker/plan.test.ts`
Expected: FAIL in `describe("recurring")`.

- [ ] **Step 3: Implement**

In `plan.ts`, add the rule step before the transaction step. Use `occurrenceDates` from `../../domain/recurrence.ts` and `occurrenceId` from `../../domain/ids.ts`. Put the rule ops between the categories and the transactions. Fill `counts.recurring_rules` and `counts.occurrences`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/import/spendingTracker`
Expected: PASS for all parser tests.

Run: `npm --workspace app run typecheck`
Expected: no errors.

---

### Task 11: Import script

**Files:**
- Create: `scripts/import-spending-tracker.ts`
- Modify: `.gitignore`
- Type: backend

The script has no automated test. It joins the tested parser with the API, and the manual check in Task 12 covers it.

- [ ] **Step 1: Write the script**

`node scripts/import-spending-tracker.ts <backup-file> [--api <url>] [--mapping <path>]`. The default for `--api` is `http://localhost:8080`, and the default for `--mapping` is `mapping.json` in the current directory. The script does these steps in this order:

1. Open the backup read-only with `new DatabaseSync(path, { readOnly: true })` from `node:sqlite`. Read the four tables into a `SourceData`. If a table is missing, print "Not a Spending Tracker backup: table <name> is missing" and exit with code 1.
2. Ask for the email, the password (no echo, with raw mode on stdin) and the TOTP code. Use `MT_EMAIL` and `MT_PASSWORD` from the environment when they are set. Call `POST /api/auth/login` with `device_name` `"import-spending-tracker"`. If the response has `mfa_token`, ask for the code and call `POST /api/auth/login/totp`. If the response has `access_token`, continue with it (the stack runs with `DISABLE_TOTP`). On an error, print the `error` code from the body and exit with code 1.
3. Call `GET /api/import/existing` with the bearer token.
4. If the mapping file does not exist, write `proposeMapping(source, existing)` as JSON with two-space indent. Print "Wrote <path>. Edit it, then run the script again." and exit with code 0.
5. Read the mapping file. Run `validateMapping`. If it returns errors, print each error on its own line and exit with code 1.
6. Compute `importBatchId` as `v5("st:batch:" + sha256 of the backup file, IMPORT_NAMESPACE)`. Export `IMPORT_NAMESPACE` from `convert.ts` for this. Call `buildPlan` with `userId` from the login response and `today` as the local date in `YYYY-MM-DD`.
7. If `mapping.currency` is not `existing.currency_code`, print a warning line.
8. Print the summary: one line for each key of `counts`, then the problems grouped by `kind`, with the count and the first 10 messages of each group.
9. Ask "Import? (y/N)". Any answer other than `y` exits with code 0 and sends nothing.
10. Send `plan.ops` in order, in batches of 200, to `POST /api/sync/upload` with `{ schema_version: SCHEMA_VERSION, ops }`. Import `SCHEMA_VERSION` from `app/src/generated/schema.ts`. Print the progress after each batch ("batch 3/23").
    - Status 200: collect each `rejected` item with the op (table, ID, `external_id`), the code and the message.
    - Network error or status 503: wait 2 seconds and send the same batch one more time. If it fails again, print "Upload stopped at batch N. Run the script again; it does not create duplicates." and exit with code 1.
    - Status 401: print "The session expired. Run the script again; it does not create duplicates." and exit with code 1.
    - Any other status: print the status and the body, and exit with code 1.
11. At the end, print the number of applied ops and each rejected op. Exit with code 1 when at least one op was rejected, else 0.

Import the parser from `../app/src/import/spendingTracker/index.ts`.

- [ ] **Step 2: Ignore the mapping file**

Add `mapping.json` to the root `.gitignore`.

- [ ] **Step 3: Check that the script loads**

Run: `node scripts/import-spending-tracker.ts /dev/null`
Expected: exit code 1 with "Not a Spending Tracker backup: table Profile is missing".

---

### Task 12: Documentation and manual check

**Files:**
- Modify: `README.md`
- Type: both

- [ ] **Step 1: Document the script**

In `README.md`, add a row to the commands table: `node scripts/import-spending-tracker.ts <backup>`. It imports a Spending Tracker backup. The first run writes `mapping.json`, and the second run imports after a confirmation. Say that a second import updates the same rows and creates no duplicates.

- [ ] **Step 2: Run all tests**

Run: `make test`
Expected: PASS.

Run: `make check-generated`
Expected: exit code 0.

- [ ] **Step 3: Manual check against the e2e stack**

1. Run `make e2e-stack-up`. Create a user with the invite flow that the e2e support code uses.
2. Run the script with a real backup and `--api http://localhost:28080`. Check that `opening_balances` in `mapping.json` has the earliest Carry Over row of each account, and that the matches are correct.
3. Run the script again and confirm. Before you confirm, compare the counts in the summary with direct `SELECT count(*)` queries on the backup: transfers are half of the paired `Transfer` rows, and each problem group lists real rows. Expected: no rejected ops.
4. Run the script a third time and confirm. Then run `SELECT count(*) FROM transactions` in PostgreSQL and check that the count is the same as after the second run.
5. Open the web app on the e2e stack. Compare the totals of the current month and the Carry Over values of two accounts with Spending Tracker.
6. Run `make e2e-stack-down`.
