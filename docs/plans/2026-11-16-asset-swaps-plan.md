# Asset Swaps Implementation Plan

**Goal:** Let a user record a swap from one portfolio asset to another, for example 1 ETH to 2,498 USDC, as one record that they create, edit and delete as one thing.

**Architecture:** A swap is one row in a new user-owned synced table `swaps`. The app and the Go FIFO port turn each swap into two virtual trades: a sell of the "from" asset and a buy of the "to" asset. A new optional `total` field on a trade lets these legs carry the exact amount that the user entered. FIFO, FX and the value series do not change. Each check for an oversell reads the trades and the swap legs of an asset together.

**Tech Stack:** Go 1.25, pgx, goose, PowerSync sync rules, JSON Schema with `make generate`, Expo (React Native and web), PowerSync JS SDK, Jest, Playwright.

---

## Context

- The plan builds on the branch `task/portfolio-insights`. That branch has `api/internal/portfolio` (the Go copy of the FIFO math), `testdata/portfolio-vectors.json` (shared test vectors for Jest and Go) and migration `00009_insight_source.sql`.
- A swap row has `from_instrument_id`, `to_instrument_id`, `date`, `from_quantity`, `to_quantity`, `fee`, `value`, `to_value` and `note`.
  - `to_quantity` is the quantity that the user received after the fee.
  - `fee` is in units of the "to" asset. It is `"0"` when there is no fee.
  - `value` is the value of the swap in the quote currency of the "from" asset. The user always enters it.
  - `to_value` is the same value in the quote currency of the "to" asset. It equals `value` when the two quote currencies are the same.
- The swap legs:
  - The sell leg on the "from" asset has `quantity = from_quantity`, `fee = "0"`, `total = value` and `price = "0"`.
  - The buy leg on the "to" asset has `quantity = to_quantity`, `fee = feePart`, `total = to_value - feePart` and `price = "0"`.
  - `feePart = fee × to_value / (to_quantity + fee)`, with the rounding of `mul` and `div` in `app/src/domain/decimal.ts`. When `fee` is 0, `feePart` is 0.
  - Both legs have `id = swap.id` and `date = swap.date`.
- `holding()` uses `total` in place of `quantity × price` when `total` is set. A buy then costs `total + fee`, and a sell gives `total - fee` before the FIFO cost. Thus the ETH proceeds equal `value` and the USDC cost equals `to_value`, without rounding.
- FX: a rate is the number of quote units for one app unit (see `toApp` in `app/src/domain/portfolio.ts`). The rate of the app currency itself is 1. For a cross-currency swap, `to_value = value × rateTo / rateFrom`, with the rates of the swap date. If one of the two rates is missing on the device, the form leaves `to_value` empty and the user types it.
- Both instruments must be in `user_instruments` for the user. The swap form does not add assets.
- `schemaVersion` and `minSupportedSchemaVersion` both become 7. Old builds get `upgrade_required` and must update. Deploy the server before the app.
- Swaps that the user entered before as two trades stay two trades. No migration links them.
- This is a public repo. All tests, fixtures and docs use made-up symbols, quantities and prices.

## File Structure

| File | Responsibility |
|---|---|
| `schema/swap.schema.json` | Swap record, synced and uploadable |
| `schema/upload.schema.json`, `schema/version.json` | `swaps` in the table enum, schema version 7 |
| `api/internal/db/migrations/00010_swaps.sql` | Table, constraints, publication and grant |
| `sync/sync-rules.yaml` | `swaps` in the user bucket |
| `api/internal/schema/validate.go`, `api/internal/sync/tables.go`, `api/internal/sync/apply.go` | Upload of `swaps` |
| `api/internal/prices/store.go` | History start reads swap dates |
| `api/internal/portfolio/holding.go`, new `api/internal/portfolio/swap.go` | `Total` on a trade, swap legs in Go |
| `api/internal/insights/portfolio_store.go` | Portfolio insights read swaps |
| `testdata/portfolio-vectors.json` | Shared vectors for `total` and for swap legs |
| `app/src/data/schema.ts` | PowerSync client table `swaps` |
| `app/src/domain/portfolio.ts` | `total` in `holding()`, `swapLegs()`, `swapToValue()` |
| `app/src/domain/validation.ts` | `SwapInput`, `validateSwap()` |
| `app/src/data/portfolio.ts` | Swaps in the rows, legs in `tradesOf()`, swaps in the instrument detail |
| `app/src/data/mutations.ts` | `saveSwap()`, `deleteSwap()`, legs in the trade checks |
| `app/src/ui/screens/SwapForm.tsx`, `app/app/swap/[id].tsx`, `app/app/_layout.tsx` | Swap form and route |
| `app/src/ui/screens/InstrumentDetail.tsx`, `app/app/instrument/[id].tsx`, `app/src/ui/screens/TradeForm.tsx` | Swap button, swap rows, legs in the trade form checks |
| `e2e/web/portfolio.spec.ts` | E2E test |

---

### Task 1: Schema, migration and sync rules

**Files:**
- Create: `schema/swap.schema.json`, `api/internal/db/migrations/00010_swaps.sql`
- Modify: `schema/upload.schema.json`, `schema/version.json`, `sync/sync-rules.yaml`, `api/internal/schema/validate.go`, `api/internal/sync/tables.go`, `app/src/data/schema.ts`
- Generated: `app/src/generated/schema.ts`, `api/internal/schema/types_gen.go`, `api/internal/schema/json/`
- Test: `api/internal/schema/validate_test.go`, `api/internal/sync/tables_test.go`, `api/internal/db/migrate_test.go`, `app/src/data/schema.test.ts`
- Type: both

- [ ] **Step 1: Write the failing tests**

1. In `api/internal/schema/validate_test.go`, add `TestValidateSwap`, in the style of `TestValidateTrade`. A valid PUT has `id`, `user_id`, `from_instrument_id`, `to_instrument_id` (uuids), `date` `"2026-03-14"`, `from_quantity` `"1"`, `to_quantity` `"2498"`, `fee` `"2"`, `value` `"2500"`, `to_value` `"2500"` and `note` null. Assert it passes. Assert these fail: `value` as the number `2500`, `from_quantity` `"1,5"`, `fee` `"-1"`, a `to_value` with 13 fraction digits, a missing `to_value`, a `note` of 201 characters, and an extra field `price`.
2. In `api/internal/sync/tables_test.go`, in `TestTableWhitelist`, assert that the table names contain `swaps`.
3. In `api/internal/db/migrate_test.go`, add `"swaps"` to `syncedTables` (keep the list sorted) and add `swaps` to the list of tables that the down migration test expects to be gone (line 119).
4. In `app/src/data/schema.test.ts`, add `swap: "swaps"` to the map at line 19, and assert that the PowerSync schema has the table `swaps`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/schema/ ./internal/sync/ -run 'TestValidateSwap|TestTableWhitelist'`
Expected: FAIL, the table `swaps` is unknown.

Run: `npm --workspace app test -- schema.test.ts`
Expected: FAIL, the table `swaps` is missing.

- [ ] **Step 3: Write the schemas**

1. `schema/swap.schema.json`: title `Swap`, `additionalProperties: false`. Required: `id`, `user_id`, `from_instrument_id`, `to_instrument_id`, `date`, `from_quantity`, `to_quantity`, `fee`, `value`, `to_value`. The ids are uuid strings. `date` uses the pattern of `schema/trade.schema.json`. The five amounts are strings with the pattern `^\d{1,12}(\.\d{1,12})?$`. `note` is a string or null with `maxLength` 200. `created_at` and `updated_at` are read-only date-time strings, as in `schema/trade.schema.json`.
2. `schema/upload.schema.json`: add `swaps` to the `table` enum.
3. `schema/version.json`: set `schemaVersion` to 7 and `minSupportedSchemaVersion` to 7.
4. `api/internal/schema/validate.go`: add `"swaps": "swap.schema.json"` to `tableSchemas`.
5. `api/internal/sync/tables.go`: add `"swaps": columnsOf(schema.Swap{})` to `tables`.

- [ ] **Step 4: Write the migration**

In `api/internal/db/migrations/00010_swaps.sql`, goose Up:

1. Create `swaps` with `id uuid PRIMARY KEY`, `user_id uuid NOT NULL`, `from_instrument_id uuid NOT NULL`, `to_instrument_id uuid NOT NULL`, `date date NOT NULL`, the five amounts as `text NOT NULL`, `note text`, `created_at` and `updated_at` as in `trades`.
2. Add `UNIQUE (user_id, id)`, `CHECK (from_instrument_id <> to_instrument_id)`, and two foreign keys: `(user_id, from_instrument_id)` and `(user_id, to_instrument_id)`, both to `user_instruments (user_id, instrument_id)`. The foreign keys make an upload for an asset that the user did not add fail with `invalid_reference`.
3. Add indexes on `(from_instrument_id, date)` and `(to_instrument_id, date)` for the price worker query in Task 3.
4. `ALTER PUBLICATION powersync ADD TABLE swaps` and `GRANT SELECT ON swaps TO powersync_repl`, as in `00008_portfolio.sql`.

Goose Down: `DROP TABLE swaps`.

- [ ] **Step 5: Write the sync rules and the client schema**

1. In `sync/sync-rules.yaml`, add `SELECT * FROM swaps WHERE user_id = bucket.user_id` to `user_data`, after the `trades` line.
2. In `app/src/data/schema.ts`, add the table `swaps` with text columns for `user_id`, `from_instrument_id`, `to_instrument_id`, `date`, the five amounts, `note`, `created_at` and `updated_at`. Add the indexes `by_from` on `from_instrument_id`, `date` and `by_to` on `to_instrument_id`, `date`. Add `swaps` to the exported schema next to `trades`.

- [ ] **Step 6: Generate and run the tests**

Run: `make generate`
Expected: exit 0. `app/src/generated/schema.ts` has the type `Swap`, and `api/internal/schema/types_gen.go` has `schema.Swap`.

Run: `go -C api test ./internal/schema/ ./internal/sync/ -run 'TestValidateSwap|TestTableWhitelist'`
Expected: PASS.

Run: `npm --workspace app test -- schema.test.ts`
Expected: PASS.

Run (on the Mac, the test needs Docker): `go -C api test ./internal/db/`
Expected: PASS. The migration runs up and down.

- [ ] **Step 7: Check the sync rules on the stack**

Run: `make stack-down && make stack-up`
Expected: the stack becomes healthy. Run `docker compose -f deploy/compose/docker-compose.yml logs powersync | grep -i error` and expect no sync rules error.

### Task 2: Upload rules for swaps

**Files:**
- Modify: `api/internal/sync/apply.go:170`
- Test: `api/internal/sync/apply_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `api/internal/sync/apply_test.go`, add `TestApplySwaps`. Copy the setup of `TestApplyTrades`: its `instrument` helper, a user from `seedUser`, and `wantRejected`. Make two linked instruments and one unlinked instrument. A helper `swap(from, to, fromQty, toQty, fee, value, toValue)` builds the op data. Cases:

1. "put_linked_applies": a swap between the two linked instruments is applied, and one `swaps` row exists for the user.
2. "put_unlinked_rejected": the "to" instrument is not linked. Assert the rejection code `invalid_reference`.
3. "same_instrument_rejected": `from` and `to` are the same linked instrument. Assert the rejection code `invalid_record`. `mapPgError` maps the CHECK violation to this code (`api/internal/sync/apply.go:109`).
4. For each of `from_quantity`, `to_quantity`, `value` and `to_value`: the value `"0.000"` is rejected with `invalid_record` and the message "<field> must be greater than 0".
5. "fee_zero_applies": `fee` `"0"` is applied.

- [ ] **Step 2: Run the tests to verify they fail**

Run (on the Mac): `go -C api test ./internal/sync/ -run TestApplySwaps`
Expected: FAIL on the zero cases.

- [ ] **Step 3: Write the implementation**

In `applyOp` in `api/internal/sync/apply.go`, the `trades` block at line 170 checks a list of fields for a value with no digit other than `0`. Change it to a map from table to fields: `trades` has `quantity` and `price`, `swaps` has `from_quantity`, `to_quantity`, `value` and `to_value`. Keep the message format "<field> must be greater than 0".

- [ ] **Step 4: Run the tests**

Run (on the Mac): `go -C api test ./internal/sync/`
Expected: PASS, also `TestApplyTrades`.

### Task 3: Price history starts at the earliest swap

**Files:**
- Modify: `api/internal/prices/store.go:37-48`
- Test: `api/internal/prices/store_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `TestHistoryStart` in `api/internal/prices/store_test.go`, add a helper `addSwap(t, pool, user, fromID, toID, date)`. It inserts the `user_instruments` rows if they are missing and one `swaps` row with made-up amounts. Add these cases:

1. "stock: a swap into the instrument is earlier than its trades": instrument `ZZSW1` has a trade on `2026-05-01` and is the "to" side of a swap on `2026-02-10`. Assert the start is `2026-02-10`.
2. "stock: a swap out of the instrument with no trades": instrument `ZZSW2` has no trades and is the "from" side of a swap on `2026-01-20`. Assert the start is `2026-01-20`.
3. "fx: a swap counts for the quote currency of both instruments": `ZZSW3.L` (GBP) is the "to" side of a swap on `2025-09-01` from a USD instrument, and `EURGBP=X` exists. Assert that the start of `EURGBP=X` is `2025-09-01`.

- [ ] **Step 2: Run the tests to verify they fail**

Run (on the Mac): `go -C api test ./internal/prices/ -run TestHistoryStart`
Expected: FAIL on the three new cases.

- [ ] **Step 3: Write the implementation**

In `historyStartSQL`, the inner `min(t.date)` reads only `trades`. Replace the source of each branch with the union of three date sets: the trade dates of the instrument, the swap dates where it is `from_instrument_id`, and the swap dates where it is `to_instrument_id`. The FX branch does the same for all non-FX instruments with the quote currency of the pair. Keep the `GREATEST`, `LEAST` and `COALESCE` frame. Update the doc comment of `historyStartSQL` to say "trade or swap".

- [ ] **Step 4: Run the tests**

Run (on the Mac): `go -C api test ./internal/prices/`
Expected: PASS.

### Task 4: Swap legs and `total` in the app domain

**Files:**
- Modify: `app/src/domain/portfolio.ts`, `app/src/domain/validation.ts`, `testdata/portfolio-vectors.json`
- Test: `app/src/domain/portfolio.test.ts`, `app/src/domain/validation.test.ts` (new file)
- Type: frontend

- [ ] **Step 1: Add the shared vectors**

In `testdata/portfolio-vectors.json`:

1. Add to `cases` a case `total_overrides_price`. Quote and app currency `USD`. Trades: a buy `b1` on `2026-03-02` with `quantity` `"3"`, `price` `"0"`, `fee` `"0.3"`, `total` `"10"`. A sell `s1` on `2026-04-01` with `quantity` `"1"`, `price` `"0"`, `fee` `"0"`, `total` `"5"`. No closes. Expect `quantity` `"2"`, `fees` `"0.3"`, a realized amount of `5 - 10.3/3` for `2026-04-01`, and the matching `cost`. Compute the exact strings with `fromFixed` once and write them in the file.
2. Add a top-level array `swaps` with these cases. Each has a `swap` object (the row fields) and `expect` with `sell` and `buy` (each with `id`, `side`, `date`, `quantity`, `price`, `fee`, `total`):
   - `no_fee`: 1 from, 2500 to, fee `"0"`, value `"2500"`, to_value `"2500"`. The buy leg has fee `"0"` and total `"2500"`.
   - `fee_in_to_asset`: 1 from, 2498 to, fee `"2"`, value `"2500"`, to_value `"2500"`. The buy leg has fee `"2"` and total `"2498"`.
   - `fee_rounds`: 0.5 from, 997 to, fee `"3"`, value `"1000"`, to_value `"910.3"`. Write the fee and total that `feePart` gives. Fee plus total must be `"910.3"`.
   - `cross_currency`: value `"2300"` and to_value `"2500"`. The sell total is `"2300"` and the buy total plus fee is `"2500"`.

- [ ] **Step 2: Write the failing tests**

1. In the `shared vectors` describe of `app/src/domain/portfolio.test.ts`, read the new `total` field of a vector trade (`Vector` type) and pass it on.
2. Add a describe `shared swap vectors`. For each case of `swaps`, call `swapLegs(c.swap)` and assert that the result equals `c.expect`.
3. Add a describe `swapToValue` with these cases:
   - Same quote currency: returns `value` as it is.
   - The "from" quote is the app currency (rate 1) and the "to" FX closes have a rate of `"1.25"` on the date: returns `value × 1.25`.
   - Neither is the app currency: `rateFrom` `"0.8"`, `rateTo` `"1.1"`: returns `value × 1.1 / 0.8`.
   - A rate exists only on an earlier date: the earlier close is used, the same as `rateOn`.
   - No "to" rate on or before the date: returns null.
4. Add a describe `validateSwap`, with a valid input and one error each for: missing `from_instrument_id`, missing `to_instrument_id`, the same instrument on both sides (`to_instrument_id`, code `same_instrument`), bad `date`, `from_quantity` `"0"`, `to_quantity` `"abc"`, `value` `"0"`, empty `to_value`, `fee` `"-1"`, and a note of 201 characters.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --workspace app test -- domain/portfolio.test.ts domain/validation.test.ts`
Expected: FAIL, `swapLegs`, `swapToValue` and `validateSwap` do not exist.

- [ ] **Step 4: Write the implementation**

1. In `app/src/domain/portfolio.ts`, add the optional field `total?: string` to `Trade`. In `holding()`, use `value(t.total)` in place of `mul(quantity, value(t.price))` when `t.total` is set, in the buy branch and in the realized amount of the sell branch. Document the field in one line: the amount before the fee, used in place of quantity × price.
2. Add the exported type `SwapRecord` with the fields `id`, `date`, `from_quantity`, `to_quantity`, `fee`, `value`, `to_value`. Add `swapLegs(swap: SwapRecord): { sell: Trade; buy: Trade }` with the rules in Context.
3. Add `swapToValue(value: string, fromQuote: string, toQuote: string, appCurrency: string, fromFx: Close[], toFx: Close[], date: string): string | null`. It returns the converted value as a decimal string (`fromFixed`), or null if a rate is missing. Use `rateOn` for each side and a rate of `SCALE` (1) when the quote is the app currency.
4. In `app/src/domain/validation.ts`, add `SwapInput` (`id?`, `from_instrument_id`, `to_instrument_id`, `date`, `from_quantity`, `to_quantity`, `fee`, `value`, `to_value`, `note?`) and `validateSwap(input)`, which uses `checkDecimal` and `checkText` as `validateTrade` does. Positive: `from_quantity`, `to_quantity`, `value`, `to_value`. Not positive: `fee`. Add `same_instrument` to `ValidationCode`.

- [ ] **Step 5: Run the tests**

Run: `npm --workspace app test -- domain/`
Expected: PASS, also all old vector cases.

### Task 5: Swap legs and `Total` in the Go port

**Files:**
- Create: `api/internal/portfolio/swap.go`, `api/internal/portfolio/swap_test.go`
- Modify: `api/internal/portfolio/holding.go`
- Test: `api/internal/portfolio/holding_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

1. In `api/internal/portfolio/holding_test.go`, add the `total` field to the vector trade struct and copy it into `portfolio.Trade.Total` in `TestSharedVectors`.
2. In `api/internal/portfolio/swap_test.go`, add `TestSharedSwapVectors`. It reads the `swaps` array of `testdata/portfolio-vectors.json`, calls `portfolio.SwapLegs` for each case, and compares each field of both legs with `expect`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/portfolio/`
Expected: FAIL to compile, `Total` and `SwapLegs` do not exist.

- [ ] **Step 3: Write the implementation**

1. In `api/internal/portfolio/holding.go`, add `Total string` to `Trade`. An empty string means "not set". In `HoldingOf`, use `value(t.Total)` in place of `Mul(quantity, value(t.Price))` when `Total` is not empty, in the buy branch and in the realized amount.
2. In `api/internal/portfolio/swap.go`, add `type Swap struct` with `ID`, `Date`, `FromQuantity`, `ToQuantity`, `Fee`, `Value`, `ToValue` (strings) and `SwapLegs(s Swap) (sell, buy Trade)` with the rules in Context. Use `Mul`, `Div` and `FormatFixed` from `fixed.go`, so that the strings equal the TypeScript result.

- [ ] **Step 4: Run the tests**

Run: `go -C api test ./internal/portfolio/`
Expected: PASS.

### Task 6: Portfolio insights read swaps

**Files:**
- Modify: `api/internal/insights/portfolio_store.go:64-70`, `api/internal/insights/portfolio_store.go:121-137`
- Test: the existing tests of `readPortfolioData` and `portfolioUsers` in `api/internal/insights/` (find them with `grep -rn "readPortfolioData\|portfolioUsers" api/internal/insights/*_test.go`)
- Type: backend

- [ ] **Step 1: Write the failing tests**

1. A user with insights on, no trades and one swap is in the result of `portfolioUsers`.
2. `readPortfolioData` for a user with a buy of 1 unit of instrument A on `2026-01-05` and a swap of 1 A to 2498 B with fee 2 on `2026-02-01`: instrument A has quantity 0 and one realized entry, and instrument B has quantity `2498` and a cost equal to `to_value`. Use made-up symbols such as `ZZA-USD` and `ZZB-USD`.

- [ ] **Step 2: Run the tests to verify they fail**

Run (on the Mac): `go -C api test ./internal/insights/ -run 'Portfolio'`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. In `portfolioUsers`, the `EXISTS` on `trades` becomes `EXISTS` on `trades` or on `swaps` for the user.
2. In `readPortfolioData`, after the trades loop, read `SELECT id::text, from_instrument_id::text, to_instrument_id::text, date::text, from_quantity, to_quantity, fee, value, to_value FROM swaps WHERE user_id = $1`. For each row, call `portfolio.SwapLegs` and append the sell leg to the "from" instrument and the buy leg to the "to" instrument in the `trades` map.

- [ ] **Step 4: Run the tests**

Run (on the Mac): `go -C api test ./internal/insights/ ./internal/portfolio/`
Expected: PASS.

### Task 7: Swaps in the portfolio data

**Files:**
- Modify: `app/src/data/portfolio.ts`
- Test: `app/src/data/portfolio.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/data/portfolio.test.ts`, use the existing database helper of the file. Insert two instruments in USD (`ZZA-USD` and `ZZB-USD`), a buy of 1 A at 2000 on `2026-01-05`, and a swap of 1 A to 2498 B with fee 2, value 2500 and to_value 2500 on `2026-02-01`. Add prices for both. Cases:

1. In `loadPortfolio`: no holding for A, a holding for B with quantity `2498` and cost `2500`, and a realized total of `500` (in USD, from the A sell).
2. In `loadPortfolio`: the series has dates from `2026-01-05`, and the value on `2026-02-01` counts B and not A.
3. In `loadPortfolio`: a user with only a swap and a trade on A (no trades on B) still gets B in `holdings`. This checks that the "traded" filter reads the legs.
4. In `instrumentDetail` for A: `swaps` has the swap, `trades` has only the buy, and `legs` has the buy and the swap sell leg.
5. In `instrumentDetail` for B: `swaps` has the swap, `trades` is empty, and `legs` has the buy leg.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- data/portfolio.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. Add `SwapRow`, picked from the generated `Swap` type: `id`, `from_instrument_id`, `to_instrument_id`, `date`, `from_quantity`, `to_quantity`, `fee`, `value`, `to_value`, `note`. Add `swaps: SwapRow[]` to `PortfolioRows`, a `swapsSql` and the load in `loadRows` and `usePortfolioRows`.
2. `tradesOf(rows, instrumentId)` returns the trades of the instrument plus the sell leg of each swap from it and the buy leg of each swap to it (`swapLegs`).
3. In `buildPortfolio`, the `traded` set also has the "from" and "to" instrument of each swap. In `seriesDates`, the first date is the earliest trade or swap date. Return early only when there are no trades and no swaps.
4. In `InstrumentDetail`, add `swaps: SwapRow[]` (the swaps that touch the instrument, newest first) and `legs: Trade[]` (`tradesOf` for the instrument). `trades` stays the list of real trades.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- data/portfolio.test.ts`
Expected: PASS, also the old cases.

### Task 8: Save and delete a swap, legs in the trade checks

**Files:**
- Modify: `app/src/data/mutations.ts`
- Test: `app/src/data/mutations.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/data/mutations.test.ts`, add a describe `saveSwap` and a describe `deleteSwap`, and add cases to `saveTrade` and `deleteTrade`. Use instruments A and B as in Task 7.

1. `saveSwap` with a valid input inserts one `swaps` row with normalized decimals (`"1,5"` becomes `"1.5"`, an empty fee becomes `"0"`).
2. `saveSwap` returns `invalid_reference` for an instrument id that is not in `instruments`.
3. `saveSwap` returns the errors of `validateSwap` and writes nothing.
4. `saveSwap` for a swap of 2 A when the user holds 1 A returns `over_held` on `from_quantity` with `held` `"1"`.
5. `saveSwap` as an edit that lowers `to_quantity` from 2498 to 100, with a later sell of 500 B: returns `over_held` with the later sell.
6. `saveSwap` as an edit that changes `to_instrument_id` from B to C, with a later sell of 500 B: returns `over_held` with the later sell of B.
7. `deleteSwap` with a later sell of 500 B returns `over_held` and keeps the row.
8. `deleteSwap` with no later sells deletes the row.
9. `saveTrade`: a sell of 500 B after a swap into B (2498) is saved. Without the swap legs, the check says 0 held.
10. `deleteTrade`: delete the buy of A before a swap out of A. Returns `over_held`, because the swap sell leg then sells more than is held.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- data/mutations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. Add a private helper `legsFor(tx, instrumentId)` that reads the trades of the instrument and the swaps that touch it, and returns the trades plus the swap legs (`swapLegs`), as `tradesOf` does in Task 7.
2. In `saveTrade` and `deleteTrade`, read the list for the oversell check with `legsFor` in place of the `trades` query.
3. Add `saveSwap(db, input: SwapInput)` in one `writeTransaction`:
   - Normalize the decimals with `normalizeDecimal`. An empty fee becomes `"0"`.
   - Run `validateSwap`. Check that both instruments exist, as `saveTrade` does.
   - Read the old swap row if `input.id` exists. Collect the instruments to check: the old and the new "from" and "to" instruments.
   - For each instrument, build the list before the change (`legsFor`) and after the change (without the old legs of this swap, with the new legs). Use the same before and after rule as `changeError` in `app/src/domain/portfolio.ts`. Export a function from there for this, for example `listError(before, after, changedId)`, and do not copy it.
   - On the first oversell, return `over_held` with the field `from_quantity` if the sell is the swap sell leg, else with the field `to_quantity` and the later sell.
   - Write the row with `write(tx, "swaps", ...)`, as `saveTrade` does.
4. Add `deleteSwap(db, id)` in one `writeTransaction`. It checks both instruments with the list before and after the delete, returns `over_held` with the later sell, else deletes the row.
5. Export `SwapInput` next to `TradeInput`.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- data/mutations.test.ts`
Expected: PASS, also the old `saveTrade` and `deleteTrade` cases.

### Task 9: Swap form and route

**Files:**
- Create: `app/src/ui/screens/SwapForm.tsx`, `app/src/ui/screens/SwapForm.test.tsx`, `app/app/swap/[id].tsx`
- Modify: `app/app/_layout.tsx:135`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/ui/screens/SwapForm.test.tsx`, follow the setup of `app/src/ui/screens/TradeForm.test.tsx`. Cases:

1. A new swap with `instrumentId` A opens with "From" set to A. "To" lists the other non-FX instruments and not A.
2. With A and B in USD, the field "Value in USD" shows, and the field for the "to" value does not show.
3. With A in USD, C in EUR, app currency EUR and an `EURUSD=X` close of `"1.25"` on the date: the "to" value field shows and the app fills it with `value / 1.25` after the user types the value. The user can change it.
4. With A in USD, C in GBP, and no GBP FX close on the date: the "to" value field is empty, and Save shows the required error on it.
5. Save of a valid swap calls `saveSwap` and closes the form.
6. A swap of more than the held quantity shows "You hold <n> <symbol> on <date>. You cannot swap <m>." under the quantity given.
7. An existing swap opens with its values. Delete asks for confirmation, calls `deleteSwap` and closes the form.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- SwapForm.test.tsx`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the form**

In `app/src/ui/screens/SwapForm.tsx`, build `SwapForm({ id, instrumentId, platform, locale, today, onClose })` with the same parts as `TradeForm`: `FormHeader`, `FormField`, `DateField`, `SelectField`, `FormAction` for delete, `confirmDialog`, `useShortcuts`. Load the swap by id and the user's instruments (without `kind = 'fx'`) and the FX closes with `useQuery`. If the swap is gone after the load, close the form, as `TradeForm` does.

The fields, in this order: "From" (select), "Quantity given", "To" (select), "Quantity received", "Fee (<to symbol>)", "Date", "Value (<from quote currency>)", "Value (<to quote currency>)" only when the two quote currencies differ, and "Note".

When the value, the date or one of the assets changes, and the user did not type a "to" value by hand, fill the "to" value with `swapToValue`. If it returns null, leave the field empty and show the note "No exchange rate for this date. Enter the value." under it. Before the save, set `to_value` to `value` when the currencies are the same.

Map `over_held` errors to text in the style of `TradeForm.tsx:191` and `TradeForm.tsx:227`. Use "swap" in place of "sell" for an error on `from_quantity`.

- [ ] **Step 4: Write the route**

1. `app/app/swap/[id].tsx`: copy the shape of `app/app/trade/[id].tsx`. `/swap/new?instrument=<id>` opens an empty form with that "from" asset. Any other id opens an edit. Close goes back, else to `/instrument/<instrument>` or `/portfolio`.
2. In `app/app/_layout.tsx`, add `<Stack.Screen name="swap/[id]" options={{ presentation: FORM_PRESENTATION }} />` after the `trade/[id]` line.

- [ ] **Step 5: Run the tests**

Run: `npm --workspace app test -- SwapForm.test.tsx`
Expected: PASS.

### Task 10: Swap button and swap rows on the asset screen

**Files:**
- Modify: `app/src/ui/screens/InstrumentDetail.tsx`, `app/app/instrument/[id].tsx`, `app/src/ui/screens/TradeForm.tsx:179`, `app/src/ui/screens/TradeForm.tsx:233`
- Test: `app/src/ui/screens/Portfolio.test.tsx` (it has the `InstrumentDetailScreen` tests), `app/src/ui/screens/TradeForm.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

1. The asset screen of A has a button with the label "Swap". A press calls `onSwap`.
2. The list under "Trades" shows the buy of A and a row "Swapped 1 ZZA-USD to 2,498 ZZB-USD" with the date of the swap, sorted with the trades by date, newest first. A press on it calls `onOpenSwap` with the swap id.
3. The asset screen of B shows the same swap row.
4. In `TradeForm.test.tsx`: a sell of 500 B after a swap into B is not blocked by the form check.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- Portfolio.test.tsx TradeForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. In `InstrumentDetailScreen`, add the props `onSwap: () => void` and `onOpenSwap: (swapId: string) => void`. Add a text button "Swap" in the header, left of the "+" button, with the same press and hover styles.
2. Merge `detail.trades` and `detail.swaps` into one list, sorted by date, newest first. Render trades with `TradeLine` as now. Render swaps with a new `SwapLine` with `testID` `swap-<id>`. It shows the date, the text "Swap", and "<from_quantity> <from symbol> → <to_quantity> <to symbol>" across the quantity and price cells. Use the symbols from the instruments of the detail data. If a symbol is not on the device, show "?".
3. In `app/app/instrument/[id].tsx`, pass `onSwap={() => router.push(`/swap/new?instrument=${id}`)}` and `onOpenSwap={(swapId) => router.push(`/swap/${swapId}`)}`.
4. In `TradeForm.tsx`, use `detail.legs` in place of `detail.trades` for `sellError` (line 179) and `deleteError` (line 233).

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test`
Expected: PASS.

### Task 11: End-to-end test

**Files:**
- Modify: `e2e/web/portfolio.spec.ts`
- Type: frontend

- [ ] **Step 1: Write the test**

In `e2e/web/portfolio.spec.ts`, add the test "swap one asset to another and see both assets". Use the same setup as the first test: `newUser`, `logIn`, the fake price source, and `enterTrade` for a buy of 2 of a made-up crypto asset A. Add a second made-up asset B in USD. Then:

1. Open the asset screen of A and press "Swap".
2. Select B in "To". Fill "Quantity given" 1, "Quantity received" 2498, "Fee" 2 and "Value" 2500. Save.
3. On the asset screen of A, expect the quantity 1 and a swap row.
4. Open the asset screen of B. Expect the quantity 2498, the cost 2,500.00 and the same swap row.
5. Open the swap row, press Delete and confirm. Expect that B has no holding and A has quantity 2 again.
6. With `waitForSynced` and the `query` helper, check that the `swaps` table on the server has no row for the user after the delete.

- [ ] **Step 2: Run the test**

Run: `make e2e-stack-up && make e2e-web`
Expected: PASS, also the old portfolio test.

### Task 12: Full check

**Files:** none
- Type: both

- [ ] **Step 1: Run all tests**

Run: `make check-generated`
Expected: exit 0 after the generated files are committed.

Run (on the Mac): `make test`
Expected: PASS.

- [ ] **Step 2: Check the deploy order**

Deploy the API and the migration before the app build with schema version 7. An app build with version 7 and an old server gets a 400 for the `swaps` table. An app build with version 6 and the new server gets `upgrade_required`.
