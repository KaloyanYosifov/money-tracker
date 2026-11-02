# Portfolio Implementation Plan

**Goal:** Let a user record buy and sell trades for stocks, ETFs and crypto, and see the holdings, FIFO cost, profit or loss, a value chart and net worth, with prices that update every hour.

**Architecture:** Trades are a new user-owned synced table. Instruments and daily prices are server-owned tables that a new Go worker fills from Yahoo Finance through a small `PriceSource` interface. A PowerSync parameter query on a server-only `user_instruments` table gives each user one bucket for each of their instruments and FX pairs. The app does all money math locally with `BigInt` on decimal strings: FIFO lots, conversion to the app currency and the value series.

**Tech Stack:** Go 1.25, pgx, goose, PowerSync service 1.27.1 and sync rules, JSON Schema with the code generator in `schema/scripts/generate.mjs`, Expo (React Native and web), PowerSync JS SDK, `react-native-svg`, Jest, Playwright, Maestro.

---

## Context

- Each asset shows its quote currency. Totals convert to `user_settings.currency_code` (the "app currency").
- An FX pair is an instrument with `kind = 'fx'` and the Yahoo symbol `<APP><QUOTE>=X`, for example `EURUSD=X`. Its close is the number of quote units for one app unit. A quote amount converts to the app currency as `amount / rate`. The rate for a date is the latest close on or before that date.
- Realized profit converts with the rate of the sale date. Open profit and value convert with the latest rate.
- Cost basis is FIFO. A buy fee adds to the cost of its lot. A sell fee lowers the proceeds of the sale. Trades of one instrument sort by `date`, then buys before sells on the same date, then `id`.
- Quantities, prices, fees and closes are decimal strings with at most 12 integer digits and 12 fraction digits. Never store them as JSON numbers or floats.
- The portfolio is separate from the accounts. Net worth is the sum of the account balances, without accounts that have `exclude_from_net_worth`, plus the portfolio value. The user records broker deposits as transfers to a "Broker" account and sets the flag on it.
- The worker fetches each instrument at most once an hour. `last_attempt_at` in Postgres controls the rate, not the ticker, so a restart does not cause extra calls.
- After 5 failures in a row, an instrument gets `failed_at` and the worker tries it only once a day.
- Yahoo search results have no currency. The search list shows the name, symbol, exchange and kind. `POST /instruments` reads the currency from a chart call.
- Yahoo gives some London listings in pence (`GBp` or `GBX`). The adapter converts them to `GBP` and divides the prices by 100.
- Search and "add asset" need the network. Trades of instruments that the user already has work offline.
- The app shows "Price from <time>" if `last_fetched_at` is older than 3 hours, and "Price unavailable. Last close <date>" if `failed_at` is set.
- This is a public repo. All tests, fixtures and docs use made-up symbols, trades and prices.
- The Excel export, alerts beyond the logs, and links between trades and accounts are out of scope.
- The mockup is the `portfolio-prototype` visual. The account form in the mockup shows an "Exclude from carry over" switch. That switch does not exist in the app, and this plan does not add it.

## File Structure

| File | Responsibility |
|---|---|
| `schema/trade.schema.json` | Trade record, synced and uploadable |
| `schema/instrument.schema.json`, `schema/instrument_price.schema.json` | Server-owned records, synced but not uploadable. Only for the generated types |
| `schema/account.schema.json` | New `exclude_from_net_worth` field |
| `schema/upload.schema.json`, `schema/version.json` | `trades` in the table enum, schema version 6 |
| `api/internal/db/migrations/00008_portfolio.sql` | Tables, publication and grants |
| `sync/sync-rules.yaml` | `trades` in the user bucket, new `instrument_data` bucket |
| `api/internal/schema/validate.go`, `api/internal/sync/tables.go`, `api/internal/sync/apply.go` | Upload of `trades` |
| `api/internal/config/config.go` | `PRICES_*` settings |
| `api/internal/prices/source.go` | `PriceSource` interface and its types |
| `api/internal/prices/decimal.go` | Float to decimal string, and the shift for pence |
| `api/internal/prices/yahoo.go` | Yahoo adapter |
| `api/internal/prices/fake.go` | Fake source for the e2e stack |
| `api/internal/prices/store.go` | SQL for instruments, links, FX pairs and prices |
| `api/internal/prices/worker.go` | Worker pass and loop |
| `api/internal/prices/handlers.go` | `GET /api/instruments/search` and `POST /api/instruments` |
| `api/internal/httpserver/server.go`, `api/cmd/mtapi/main.go` | Routes and the worker start |
| `app/src/data/schema.ts` | PowerSync client tables |
| `app/src/domain/decimal.ts` | Fixed-point math on decimal strings |
| `app/src/domain/portfolio.ts` | FIFO, conversion, value series, sell check |
| `app/src/domain/validation.ts`, `app/src/data/mutations.ts` | Trade validation and save, account flag |
| `app/src/data/portfolio.ts` | Portfolio queries and hooks |
| `app/src/data/queries.ts` | Account total for net worth |
| `app/src/data/instrumentsApi.ts` | Client for the two endpoints |
| `app/src/ui/charts/LineChart.tsx` | Line chart for prices and value |
| `app/src/ui/screens/Portfolio.tsx`, `InstrumentDetail.tsx`, `AddInstrument.tsx`, `TradeForm.tsx` | Screens |
| `app/app/(main)/portfolio.tsx`, `app/app/instrument/[id].tsx`, `app/app/instrument/add.tsx`, `app/app/trade/[id].tsx` | Routes |
| `app/src/ui/nav/TabBar.tsx`, `app/src/ui/icons/tabIcons.tsx` | Portfolio tab and icon |
| `app/src/ui/screens/Accounts.tsx` | "Exclude from net worth" switch |
| `deploy/compose/docker-compose.e2e.yml`, `docs/operations.md` | Fake prices in e2e, operations notes |
| `e2e/web/portfolio.spec.ts`, `app/e2e/maestro/portfolio.yaml`, `e2e/ios/run.ts` | E2E tests |

---

### Task 1: Schemas, migration and sync rules

**Files:**
- Create: `schema/trade.schema.json`, `schema/instrument.schema.json`, `schema/instrument_price.schema.json`, `api/internal/db/migrations/00008_portfolio.sql`
- Modify: `schema/account.schema.json`, `schema/upload.schema.json`, `schema/version.json`, `sync/sync-rules.yaml`, `api/internal/schema/validate.go`, `api/internal/sync/tables.go`, `app/src/data/schema.ts`
- Generated: `app/src/generated/schema.ts`, `api/internal/schema/types_gen.go`, `api/internal/schema/json/`
- Test: `api/internal/schema/validate_test.go`, `api/internal/sync/tables_test.go`, `app/src/data/schema.test.ts`, `api/internal/db/migrate_test.go`
- Type: both

- [ ] **Step 1: Write the failing tests**

1. In `api/internal/schema/validate_test.go`, add `TestValidateTrade`. A valid PUT has `id`, `user_id`, `instrument_id` (uuids), `side` `"buy"`, `date` `"2026-03-14"`, `quantity` `"0.00012345"`, `price` `"172.5"`, `fee` `"1"`. Assert it passes. Assert these fail: `side` `"hold"`, `quantity` `1.5` (a number, not a string), `quantity` `"1,5"`, `quantity` `"-1"`, a quantity with 13 fraction digits, a missing `fee`, and an extra field `currency_code`.
2. In `api/internal/sync/tables_test.go`, assert that `TableNames()` contains `trades` and does not contain `instruments`, `instrument_prices` or `user_instruments`.
3. In `app/src/data/schema.test.ts`, follow the existing checks and assert that the PowerSync schema has the tables `trades`, `instruments` and `instrument_prices`, and that `accounts` has the column `exclude_from_net_worth`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/schema/ ./internal/sync/ -run 'TestValidateTrade|TestTableNames'`
Expected: FAIL, the table `trades` is unknown.

Run: `npm --workspace app test -- schema.test.ts`
Expected: FAIL, the table `trades` is missing.

- [ ] **Step 3: Write the schemas**

1. `schema/trade.schema.json`: title `Trade`, `additionalProperties: false`, required `id`, `user_id`, `instrument_id`, `side`, `date`, `quantity`, `price`, `fee`. `side` is the enum `buy`, `sell`. `date` has `format: date`. `quantity`, `price` and `fee` are strings with the pattern `^\d{1,12}(\.\d{1,12})?$`. `note` is a string or null, `maxLength` 200. `created_at` and `updated_at` are read-only date-time strings, as in `schema/transaction.schema.json`.
2. `schema/instrument.schema.json`: title `Instrument`. Fields `id`, `symbol` (max 20), `name` (max 120), `exchange` (max 40), `kind` (enum `stock`, `etf`, `crypto`, `fx`), `quote_currency` (pattern `^[A-Z]{3}$`), `last_fetched_at` and `failed_at` (date-time or null).
3. `schema/instrument_price.schema.json`: title `InstrumentPrice`. Fields `id`, `instrument_id`, `date` (format date), `close` (the decimal pattern above), `as_of` (date-time).
4. `schema/account.schema.json`: add `exclude_from_net_worth`, boolean, default false.
5. `schema/upload.schema.json`: add `trades` to the `table` enum. Do not add the server-owned tables.
6. `schema/version.json`: set `schemaVersion` to 6. Keep `minSupportedSchemaVersion` at 3.
7. `api/internal/schema/validate.go`: add `"trades": "trade.schema.json"` to `tableSchemas`.
8. `api/internal/sync/tables.go`: add `"trades": columnsOf(schema.Trade{})` to `tables`.

- [ ] **Step 4: Write the migration**

In `api/internal/db/migrations/00008_portfolio.sql`, in the goose Up section:

1. `ALTER TABLE accounts ADD COLUMN exclude_from_net_worth boolean NOT NULL DEFAULT false`.
2. `instruments`: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `symbol text NOT NULL UNIQUE`, `name`, `exchange`, `kind` with a CHECK for the 4 kinds, `quote_currency text NOT NULL`. Worker state: `last_fetched_at timestamptz`, `last_attempt_at timestamptz`, `history_from date`, `fail_count int NOT NULL DEFAULT 0`, `failed_at timestamptz`, `fail_reason text`, plus `created_at` and `updated_at`.
3. `instrument_prices`: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `instrument_id uuid NOT NULL REFERENCES instruments ON DELETE CASCADE`, `date date NOT NULL`, `close text NOT NULL`, `as_of timestamptz NOT NULL`, `UNIQUE (instrument_id, date)`.
4. `user_instruments`: `user_id uuid NOT NULL`, `instrument_id uuid NOT NULL REFERENCES instruments`, `PRIMARY KEY (user_id, instrument_id)`.
5. `trades`: the columns of the schema, with `side` CHECK, `quantity`, `price`, `fee` as `text NOT NULL`, `note text`, `created_at`, `updated_at`, `UNIQUE (user_id, id)`, and `FOREIGN KEY (user_id, instrument_id) REFERENCES user_instruments (user_id, instrument_id)`. This foreign key makes an upload of a trade for an instrument that the user did not add fail with `invalid_reference` (`mapPgError` in `api/internal/sync/apply.go`). Add an index on `(instrument_id, date)`.
6. `ALTER PUBLICATION powersync ADD TABLE instruments, instrument_prices, user_instruments, trades` and `GRANT SELECT` on the same 4 tables to `powersync_repl`, as in `00007_insights.sql`.

The Down section drops the 4 tables in reverse order and the account column.

- [ ] **Step 5: Write the sync rules and the client schema**

1. In `sync/sync-rules.yaml`, add `SELECT * FROM trades WHERE user_id = bucket.user_id` to `user_data`.
2. Add the bucket `instrument_data` with `parameters: SELECT instrument_id FROM user_instruments WHERE user_id = request.user_id()`. Its data queries are `SELECT id, symbol, name, exchange, kind, quote_currency, last_fetched_at, failed_at FROM instruments WHERE id = bucket.instrument_id` and `SELECT id, instrument_id, date, close, as_of FROM instrument_prices WHERE instrument_id = bucket.instrument_id`. Do not sync the other worker columns.
3. In `app/src/data/schema.ts`, add `exclude_from_net_worth: column.integer` to `accounts`. Add the tables `trades` (index `by_instrument` on `instrument_id`, `date`), `instruments` and `instrument_prices` (index `by_instrument_date` on `instrument_id`, `date`), with text columns for all decimal values.

- [ ] **Step 6: Generate and run the tests**

Run: `make generate && make check-generated`
Expected: exit 0.

Run: `go -C api test ./internal/schema/ ./internal/sync/ ./internal/db/`
Expected: PASS. `migrate_test.go` runs the new migration up and down.

Run: `npm --workspace app test -- schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Check the sync rules on the stack**

Run: `make stack-down && make stack-up`
Expected: the stack becomes healthy. Run `docker compose -f deploy/compose/docker-compose.yml logs powersync | grep -i error` and expect no sync rules error. If PowerSync refuses the parameter query on `user_instruments`, stop and report it. The fallback is one global bucket with the same two data queries and no parameter.

### Task 2: Upload rules for trades

**Files:**
- Modify: `api/internal/sync/apply.go`
- Test: `api/internal/sync/apply_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `api/internal/sync/apply_test.go`, use the existing helpers for a user and an upload. Add `TestApplyTrades` with these cases:

1. "put a trade for a linked instrument": insert an instrument and a `user_instruments` row for the user, then upload a PUT. Assert status applied and one `trades` row.
2. "put a trade for an instrument the user did not add": no `user_instruments` row. Assert the rejection code `invalid_reference`.
3. "quantity zero": `quantity` `"0"` or `"0.000"`. Assert the rejection code `invalid_record` with the message "quantity must be greater than 0".
4. "price zero": the same rule and message for `price`.
5. "fee zero is fine": `fee` `"0"` is applied.
6. "uploads to server tables are refused": a PUT for table `instruments` fails the upload schema check (the table is not in the enum). Assert the rejection that the existing tests expect for an unknown table.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/sync/ -run TestApplyTrades`
Expected: FAIL on the zero cases.

- [ ] **Step 3: Write the implementation**

In `applyOp` in `api/internal/sync/apply.go`, after the schema check, add a check for table `trades`. For PUT and PATCH, if `quantity` or `price` is in `data` and has no digit other than `0`, reject with `invalid_record` and "<field> must be greater than 0".

- [ ] **Step 4: Run the tests**

Run: `go -C api test ./internal/sync/`
Expected: PASS.

### Task 3: Price settings

**Files:**
- Modify: `api/internal/config/config.go`
- Test: `api/internal/config/config_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `api/internal/config/config_test.go`, add cases with the existing env helper:

1. No `PRICES_*` variables: `PricesEnabled` is true, `PricesFake` is false, `PricesSourceURL` is `https://query1.finance.yahoo.com`, `PricesInterval` is 5 minutes.
2. `PRICES_ENABLED=false`, `PRICES_FAKE=true`, `PRICES_SOURCE_URL=http://stub:9000`, `PRICES_INTERVAL=2s` give those values.
3. `PRICES_INTERVAL=abc` and `PRICES_INTERVAL=0s` give an error that names `PRICES_INTERVAL`.
4. `PRICES_SOURCE_URL=not a url` gives an error that names `PRICES_SOURCE_URL`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/config/`
Expected: FAIL, the fields do not exist.

- [ ] **Step 3: Write the implementation**

Add `PricesEnabled bool`, `PricesFake bool`, `PricesSourceURL string` and `PricesInterval time.Duration` to `Config`, and parse them in `Load` with the rules above. Use `strconv.ParseBool`, `time.ParseDuration` and `url.Parse` (with a scheme and a host), and add each problem to `errs`, as the other fields do.

- [ ] **Step 4: Run the tests**

Run: `go -C api test ./internal/config/`
Expected: PASS.

### Task 4: PriceSource, decimals and the Yahoo adapter

**Files:**
- Create: `api/internal/prices/source.go`, `api/internal/prices/decimal.go`, `api/internal/prices/yahoo.go`, `api/internal/prices/fake.go`
- Create: `api/internal/prices/testdata/search.json`, `chart_usd.json`, `chart_gbp_pence.json`, `chart_gaps.json`
- Test: `api/internal/prices/decimal_test.go`, `api/internal/prices/yahoo_test.go`, `api/internal/prices/fake_test.go`
- Type: backend

- [ ] **Step 1: Write the types**

In `source.go`, define:

- `Match` with `Symbol`, `Name`, `Exchange`, `Kind` (`stock`, `etf` or `crypto`).
- `DailyClose` with `Date` (a `time.Time` at UTC midnight) and `Close` (a decimal string).
- `Chart` with `Symbol`, `Name`, `Exchange`, `Kind`, `Currency`, `Closes []DailyClose`, `Latest` (decimal string) and `LatestAt` (`time.Time`).
- `ErrNotFound` and `ErrRateLimited`.
- The interface `PriceSource` with `Search(ctx, query string) ([]Match, error)` and `Chart(ctx, symbol string, from time.Time) (Chart, error)`.

- [ ] **Step 2: Write the failing decimal tests**

In `decimal_test.go`, test `FormatDecimal(v float64) string`: `172.5` gives `"172.5"`, `0.00012345` gives `"0.00012345"`, `100` gives `"100"`, a value with more than 12 fraction digits is rounded to 12 digits, and NaN, Inf and negative values give an error. Test `ShiftDecimal(s string, places int) string`: `"2685"` with 2 gives `"26.85"`, `"5.5"` with 2 gives `"0.055"`, `"0.1"` with 2 gives `"0.001"`.

- [ ] **Step 3: Write the failing Yahoo tests**

In `yahoo_test.go`, start an `httptest.Server` that serves the testdata files. All values in the files are made up. Add cases:

1. Search: a request to `/v1/finance/search` with `q=acme`. Assert the query has `quotesCount=10` and `newsCount=0`, and the request has a `User-Agent` header. The fixture has an `EQUITY`, an `ETF`, a `CRYPTOCURRENCY` and an `OPTION`. Assert 3 matches with kinds `stock`, `etf`, `crypto`, and that the option is dropped. The name is `longname`, else `shortname`. The exchange is `exchDisp`.
2. Chart: a request to `/v8/finance/chart/ACME` with `interval=1d` and `period1` equal to the Unix time of `from`. Assert the currency `USD`, the kind `stock` from `meta.instrumentType` `EQUITY` (with the same mapping as search, and `CURRENCY` maps to `fx`), the name from `meta.longName`, else `meta.shortName`, the exchange from `meta.fullExchangeName`, the closes in order, the `Latest` value from `meta.regularMarketPrice`, and `LatestAt` from `meta.regularMarketTime`.
3. Chart with gaps: `null` closes in the fixture are skipped.
4. Pence: a fixture with currency `GBp`. Assert the currency `GBP`, and that each close and `Latest` is divided by 100. Do the same check for `GBX`.
5. HTTP 404, and a body with `chart.error.code` `"Not Found"`: assert `ErrNotFound`.
6. HTTP 429: assert `ErrRateLimited`.
7. Timeout: the server sleeps longer than the client timeout (set it to 50 ms in the test). Assert an error that wraps `context.DeadlineExceeded`.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `go -C api test ./internal/prices/`
Expected: FAIL, the package has no implementation.

- [ ] **Step 5: Write the implementation**

1. `decimal.go`: `FormatDecimal` uses `strconv.FormatFloat(v, 'f', -1, 64)` and rounds to 12 fraction digits if necessary. `ShiftDecimal` moves the decimal point on the string, so no float math happens.
2. `yahoo.go`: `NewYahoo(baseURL string, client *http.Client) *Yahoo`. A nil client gets a client with a 10 second timeout. Each request sets a browser-like `User-Agent`. `Chart` sets `period2` to now. It maps each timestamp to its UTC date.
3. `fake.go`: `NewFake()` returns a deterministic source for the e2e stack. `Search` returns one `stock` match with the symbol in upper case, the name `<SYMBOL> Test Corp` and the exchange `NASDAQ`. `Chart` returns the same name, exchange and kind (`fx` for a symbol that ends with `=X`), and a close of `"100"` for each day from `from` to today. The currency is `EUR` if the symbol ends with `.DE`, else `USD`. For an FX symbol (it ends with `=X`), the close is `"1.25"` and the currency is the last 3 letters before `=X`. `Latest` is the last close and `LatestAt` is now.
4. In `fake_test.go`, assert these rules.

- [ ] **Step 6: Run the tests**

Run: `go -C api test ./internal/prices/`
Expected: PASS.

### Task 5: Price store

**Files:**
- Create: `api/internal/prices/store.go`
- Test: `api/internal/prices/store_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `store_test.go`, use `testutil.StartPostgres`, as `api/internal/insights/worker_test.go` does. Add cases:

1. `LinkInstrument(ctx, pool, userID, chart, kind)` creates the instrument from the chart data and the `user_instruments` row, and returns the instrument. A second call for the same symbol and user creates no second row and returns the same id.
2. `EnsureFXPairs(ctx, pool)`: a user with app currency `EUR` and a `USD` instrument gets an instrument `EURUSD=X` (kind `fx`, quote currency `USD`, name `EUR/USD`) and a `user_instruments` row for it. A `EUR` instrument needs no pair. A second call adds nothing. After the user changes the app currency to `GBP`, the next call adds `GBPUSD=X`.
3. `HistoryStart(ctx, tx, instrument, today)`: an instrument with no trades gives today minus 7 days. A stock gives the earliest trade date over all users. An FX pair gives the earliest trade date over all instruments with its quote currency.
4. `SavePrices(ctx, tx, instrumentID, chart)` upserts one row for each close, and one row for the UTC date of `LatestAt` with `close = Latest` and `as_of = LatestAt`. A second call with a new latest price updates the row of today and adds no row.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/prices/ -run 'TestLinkInstrument|TestEnsureFXPairs|TestHistoryStart|TestSavePrices'`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Write the 4 functions in `store.go` with plain SQL. `LinkInstrument` uses `INSERT ... ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name RETURNING id` and `INSERT ... ON CONFLICT DO NOTHING` for the link. `EnsureFXPairs` is one SQL statement that selects the distinct pairs of app currency and quote currency for each user, where the two differ, inserts the missing instruments, then inserts the missing links.

- [ ] **Step 4: Run the tests**

Run: `go -C api test ./internal/prices/`
Expected: PASS.

### Task 6: Price worker

**Files:**
- Create: `api/internal/prices/worker.go`
- Modify: `api/cmd/mtapi/main.go`
- Test: `api/internal/prices/worker_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `worker_test.go`, use a fake `PriceSource` that records the calls and returns a set result or error for each symbol. Call `RunPass(ctx, pool, src, now)` with a fixed `now`. Add cases:

1. "a new instrument is fetched": `last_attempt_at` is null. After the pass, it has price rows, `last_fetched_at = now`, `last_attempt_at = now`, `fail_count = 0`, and `history_from` equal to the `from` of the call.
2. "an instrument fetched 30 minutes ago is not due": no call.
3. "an instrument fetched 61 minutes ago is due", and its `from` is today minus 7 days, because `history_from` is earlier than the history start.
4. "an older trade starts a backfill": `last_attempt_at` is 10 minutes ago, `fail_count` is 0, and a trade is earlier than `history_from`. Assert one call with `from` equal to the trade date, and the new `history_from`.
5. "a failure counts": the source returns an error. Assert `fail_count = 1`, `fail_reason` is set (at most 200 characters), `last_attempt_at = now`, `last_fetched_at` is unchanged, and no `failed_at`. A pass 10 minutes later makes no call.
6. "five failures set failed_at": after the fifth failure, `failed_at = now`. A pass 2 hours later makes no call. A pass 25 hours later makes a call. A success resets `fail_count`, `failed_at` and `fail_reason`.
7. "one failure does not stop the pass": two due instruments, the first fails. Assert the second has prices.
8. "two passes at the same time fetch each instrument once": start two `RunPass` calls at the same time with a source that blocks until both started. Assert one call for each symbol.
9. "the pass adds FX pairs": a user with a `USD` trade and app currency `EUR`. After the pass, `EURUSD=X` exists and has prices.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/prices/ -run TestRunPass`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

In `worker.go`:

1. `RunPass` calls `EnsureFXPairs`, then repeats this up to 50 times: open a transaction, select one due instrument with `FOR UPDATE SKIP LOCKED LIMIT 1`, compute `HistoryStart`, call `Chart`, save, update the state, commit. It stops when no instrument is due.
2. An instrument is due if `last_attempt_at` is null, or `last_attempt_at` is older than 1 hour (no `failed_at`) or 24 hours (with `failed_at`), or `failed_at` is null and `fail_count` is 0 and the history start is earlier than `history_from`. Compute the history start in the same SQL statement, with a CTE that has the rules of `HistoryStart`, so that the `FOR UPDATE SKIP LOCKED` select gives only due rows.
3. `from` is the history start if `history_from` is null or later than the history start, else `now` minus 7 days.
4. Each `Chart` call gets a 15 second context timeout.
5. On a failure, log `slog.Warn("price fetch failed", "symbol", ..., "err", ...)` and update the failure state. On 5 failures in a row, set `failed_at`.
6. `RunWorker(ctx, pool, src, interval)` runs `RunPass` at once and then on each tick, until `ctx` is done. It logs a pass error with `slog.Error`, as `insights.RunWorker` does.

In `api/cmd/mtapi/main.go`, in `serve`, if `cfg.PricesEnabled`, start `prices.RunWorker` in `workers.Go` with `prices.NewFake()` if `cfg.PricesFake`, else `prices.NewYahoo(cfg.PricesSourceURL, nil)`, and `cfg.PricesInterval`. Log "price worker started" or "PRICES_ENABLED is false: the price worker is off". Call `slog.SetDefault(logger)` before both workers start, not only in the AI branch.

- [ ] **Step 4: Run the tests**

Run: `go -C api test ./internal/prices/ ./cmd/...`
Expected: PASS.

### Task 7: Search and add endpoints

**Files:**
- Create: `api/internal/prices/handlers.go`
- Modify: `api/internal/httpserver/server.go`
- Test: `api/internal/prices/handlers_test.go`, `api/internal/httpserver/server_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `handlers_test.go`, wrap the handlers in `RequireUser` and send a bearer token, as the `existingEnv` setup in `api/internal/sync/existing_test.go` does. Use a fake source. Add cases:

1. Search with no user: 401.
2. Search with `q` shorter than 2 or longer than 50 characters after trim: 400 `invalid_query`.
3. Search `q=acme`: 200 and `{"results":[{"symbol","name","exchange","kind"}]}`.
4. Search, the 11th call of one user in one minute: 429 `rate_limited`. A second user is not limited.
5. Search, the source returns an error: 503 `unavailable`.
6. Add with the body `{"symbol":"ACME"}`: 200 with `id`, `symbol`, `name`, `exchange`, `kind`, `quote_currency`. The instrument and the link exist.
7. Add a symbol that does not match `^[A-Za-z0-9.^=-]{1,20}$`: 400 `invalid_symbol`.
8. Add, the source returns `ErrNotFound`: 404 `not_found`.
9. Add the same symbol two times: the same `id` and one instrument row.
10. Add a symbol that ends with `=X`: 400 `invalid_symbol`. Users do not add FX pairs.

In `server_test.go`, assert that `GET /api/instruments/search` and `POST /api/instruments` without a token return 401.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/prices/ ./internal/httpserver/ -run 'Handler|Instrument'`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. `NewSearchHandler(src PriceSource, limiter *auth.IPLimiter, logger)`. Use `auth.UserID(r.Context())` and `limiter.Allow("search:"+userID, time.Now())`. The limit of `auth.NewIPLimiter` is 10 requests a minute, and that is enough for search.
2. `NewAddHandler(pool, src, logger)`. If the instrument exists, link it. Else call `src.Chart(ctx, symbol, now minus 7 days)` to get the name, exchange, kind and currency. If the kind is `fx`, return 400 `invalid_symbol`. Then call `LinkInstrument`. The first prices come with the next worker pass.
3. Use the `writeJSON` and `writeError` shape of `api/internal/sync`. Copy the two small helpers into the package if they are not exported.
4. In `httpserver.New`, build the source from `cfg` (fake or Yahoo) and register both routes behind `authHandlers.RequireUser`.

- [ ] **Step 4: Run the tests**

Run: `make test-api`
Expected: PASS.

### Task 8: Decimal math in the app

**Files:**
- Create: `app/src/domain/decimal.ts`
- Test: `app/src/domain/decimal.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `decimal.test.ts`, test these functions. All values are `bigint` with a fixed scale of 10^12.

1. `toFixed("172.5")` is `172500000000000n`. `toFixed("0.000000000001")` is `1n`. `toFixed("abc")` and `toFixed("1.0000000000001")` return null.
2. `fromFixed(172500000000000n)` is `"172.5"`. `fromFixed(0n)` is `"0"`. Negative values keep the sign.
3. `mul(toFixed("0.0425"), toFixed("68120"))` is `toFixed("2895.1")`. `div(toFixed("2895.1"), toFixed("1.0846"))` rounds half up at the 12th digit.
4. `toMinor(toFixed("2669.285"), 2)` is `266929` (half up), for the amounts that `formatAmount` in `app/src/domain/money.ts` shows.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- decimal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Write the 5 functions in `decimal.ts` with `BigInt` only. Use the same parse rules as `decimalToMinor` in `app/src/domain/money.ts` ("." as the separator).

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- decimal.test.ts`
Expected: PASS.

### Task 9: FIFO, conversion and the value series

**Files:**
- Create: `app/src/domain/portfolio.ts`
- Test: `app/src/domain/portfolio.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `portfolio.test.ts`, use made-up trades of a symbol `ACME`. Add cases:

1. `holding(trades)` with buy 10 at 80 fee 1, buy 5 at 90 fee 0, sell 4 at 100 fee 0: open quantity 11, cost of open lots 6 × 80.1 + 5 × 90 = 930.6, realized `[{ date of the sell, amount: 400 - 4 × 80.1 = 79.6 }]`.
2. A sell over two lots: buy 2 at 10, buy 3 at 20, sell 4 at 30 fee 2. Realized `120 - 2 - (20 + 40) = 58`. Open quantity 1, open cost 20.
3. A buy and a sell on the same date: the buy counts first.
4. Very small crypto quantities: buy `"0.00012345"` at `"68120"`. Open cost is exact, with no float error.
5. `sellError(trades, candidate)`: a sell of 15 when 12 are held on that date returns `{ held: "12" }`. A sell of 12 returns null. An edit of an existing sell excludes the old version of that trade. A new buy that is dated before an existing sell does not cause an error. A new sell that makes a later existing sell too large returns the held quantity on the candidate date.
6. `rateOn(fxCloses, date)`: the close of that date, else the latest earlier close, else null.
7. `toApp(amount, quoteCurrency, appCurrency, rate)`: the same currency returns the amount, no rate returns null, else `amount / rate`.
8. `valueSeries(instruments, dates)`: for each date, the sum over instruments of open quantity on that date × close on or before that date ÷ FX rate on or before that date. An instrument with no close before a date counts 0 on that date.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- portfolio.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Write the functions in `portfolio.ts` with the helpers of `decimal.ts`. A buy fee spreads over its lot by quantity. A sell takes the oldest lots first and splits a lot if necessary. Sort trades as the Context section says.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- portfolio.test.ts`
Expected: PASS.

### Task 10: Trade save and the account flag

**Files:**
- Modify: `app/src/domain/validation.ts`, `app/src/data/mutations.ts`
- Test: `app/src/data/mutations.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `app/src/data/mutations.test.ts`, with the existing database and fixture helpers, add `describe("saveTrade")`:

1. A valid buy is inserted with the `user_id` of the settings row and the decimal strings as given (after trim, with "," changed to ".").
2. An edit keeps the `id` and changes the fields.
3. Errors, each as `{ field, code }` and no row written: `quantity` empty or `"0"` is `{ quantity, invalid }`; `price` `"abc"` is `{ price, invalid }`; `fee` empty is saved as `"0"`; `date` `"2026-02-30"` is `{ date, invalid }`; `note` longer than 200 is `{ note, too_long }`; a sell larger than the held quantity is `{ quantity, over_held }` with the held quantity in the error.
4. `deleteTrade(db, id)` removes the row.

Add to `describe("saveAccount")`: `exclude_from_net_worth: true` is stored as 1, and an edit without the field keeps the stored value.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- mutations.test.ts -t "saveTrade|saveAccount"`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. In `validation.ts`, add `TradeInput` and `validateTrade`, with the field rules above and the decimal pattern of the schema. Add `exclude_from_net_worth?: boolean` to `AccountInput`.
2. In `mutations.ts`, add `saveTrade` and `deleteTrade`. `saveTrade` reads the other trades of the instrument and calls `sellError` from `app/src/domain/portfolio.ts`. Write `exclude_from_net_worth` in `saveAccount` when it is given.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- mutations.test.ts`
Expected: PASS.

### Task 11: Portfolio queries and net worth

**Files:**
- Create: `app/src/data/portfolio.ts`
- Modify: `app/src/data/queries.ts`
- Test: `app/src/data/portfolio.test.ts`, `app/src/data/queries.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

1. In `queries.test.ts`, add `describe("accountsTotal")`: the sum of the balances of all accounts up to and with today, without accounts that have `exclude_from_net_worth = 1`. Use the same fixture style as the `carryOver` tests.
2. In `portfolio.test.ts`, with the same database helpers, insert instruments, prices (two dates) and trades. Assert that `loadPortfolio(db, appCurrency, today)` returns one holding for each instrument with open quantity above 0. Each holding has the quote values, the app values, the profit, `lastFetchedAt`, `failed`, and the series for the chart. An instrument with only closed positions is not in the list, but its realized profit is in the total. An instrument with no price shows a value of null.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- portfolio.test.ts queries.test.ts -t "accountsTotal|loadPortfolio"`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. In `queries.ts`, add `accountsTotal(today)`. It uses `balancesCte` with `before` set to the day after today, joins `accounts`, and filters `exclude_from_net_worth = 0`. Add the hook `useAccountsTotal()`.
2. In `portfolio.ts`, add the SQL for the trades, instruments and prices of the user, and `loadPortfolio`, which calls the functions of `app/src/domain/portfolio.ts`. Add the hook `usePortfolio()` with the watched query pattern of the hooks in `queries.ts`, and `useInstrument(id)` for the detail screen.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- portfolio.test.ts queries.test.ts`
Expected: PASS.

### Task 12: Instruments API client

**Files:**
- Create: `app/src/data/instrumentsApi.ts`
- Test: `app/src/data/instrumentsApi.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

Mock `fetch`, as `app/src/data/session.test.ts` does for `createSessionsApi`. Add cases:

1. `search("acme")` sends `GET /api/instruments/search?q=acme` with the bearer token and returns the results.
2. `add("ACME")` sends a POST with the JSON body and returns the instrument.
3. A thrown `fetch` gives `{ ok: false, error: "network" }`. 401 gives `unauthorized`. 429 gives `rate_limited`. 404 gives `not_found`. Other errors give `server`. No token gives `unauthorized` and no request.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- instrumentsApi.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Write `createInstrumentsApi({ apiUrl?, platform?, getAccessToken })` with the same headers and result shape as `createSessionsApi` in `app/src/data/session.ts`.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- instrumentsApi.test.ts`
Expected: PASS.

### Task 13: Line chart

**Files:**
- Create: `app/src/ui/charts/LineChart.tsx`
- Test: `app/src/ui/charts/LineChart.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

Render `LineChart` with 3 points and a color. Assert one `Polyline` with 3 points that fills the given width and height, with the highest value at the top. With 0 or 1 point, assert that it renders the text "Not enough data".

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- LineChart.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Use `react-native-svg`, as `app/src/ui/charts/CashFlowChart.tsx` does. Props are `points: { date: string; value: number }[]`, `color`, `height` and an accessibility label. The values are numbers only for the drawing.

- [ ] **Step 4: Run the test**

Run: `npm --workspace app test -- LineChart.test.tsx`
Expected: PASS.

### Task 14: Portfolio tab and asset detail

**Files:**
- Create: `app/src/ui/screens/Portfolio.tsx`, `app/src/ui/screens/InstrumentDetail.tsx`, `app/app/(main)/portfolio.tsx`, `app/app/instrument/[id].tsx`
- Modify: `app/src/ui/nav/TabBar.tsx`, `app/src/ui/icons/tabIcons.tsx`
- Test: `app/src/ui/screens/Portfolio.test.tsx`, `app/app/(main)/layout.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `Portfolio.test.tsx`, with mocked hooks:

1. The chalkboard shows net worth, the accounts total, the portfolio value, the open profit and the realized profit, in the app currency.
2. Each holding row shows the name, the symbol, the quantity, the quote value, the app value and the profit in %. A loss uses the red list color.
3. A holding with `lastFetchedAt` 4 hours ago shows "Price from 14:00, 30 Oct". A holding with `failed` shows "Price unavailable. Last close 12 Sep".
4. With no holdings, the screen shows "No assets yet" and an "Add asset" button.
5. The range buttons 1M, 6M, 1Y and All change the series of the chart.
6. `InstrumentDetail` shows the open quantity, the value, the cost of open lots, the open and realized profit, the fees and the trades, newest first. A tap on a trade calls `onOpenTrade(id)`.

In `layout.test.tsx`, assert that the Portfolio tab shows after Reports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- Portfolio.test.tsx layout.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

1. Add the icon name `chart` to `TabIconName` and draw it in `tabIcons.tsx` in the style of the other icons.
2. In `TabBar.tsx`, add `{ name: "portfolio", title: "Portfolio", icon: "chart", usesPeriod: false }` after `reports`. Portfolio is the sixth page, so keys 1 to 5 do not change. Update the comment above `PAGES`.
3. Build the screens with the theme colors of `app/src/ui/theme.ts` and the layout of the `portfolio-prototype` visual. Use `formatAmount` for app amounts, and `Intl.NumberFormat` with the quote currency for quote amounts.
4. Add the routes. `app/app/(main)/portfolio.tsx` opens `/instrument/<id>` and `/instrument/add`. `app/app/instrument/[id].tsx` uses `DeskScreen`, as `app/app/account/[id].tsx` does, and opens `/trade/new?instrument=<id>` and `/trade/<id>`.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- Portfolio.test.tsx layout.test.tsx`
Expected: PASS.

### Task 15: Add asset and trade form

**Files:**
- Create: `app/src/ui/screens/AddInstrument.tsx`, `app/src/ui/screens/TradeForm.tsx`, `app/app/instrument/add.tsx`, `app/app/trade/[id].tsx`
- Test: `app/src/ui/screens/AddInstrument.test.tsx`, `app/src/ui/screens/TradeForm.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

In `AddInstrument.test.tsx`, with a mocked `InstrumentsApi` and fake timers:

1. Typing "a" sends no request. Typing "acme" sends one request 300 ms after the last key.
2. The results show the name, the symbol, the exchange and the kind.
3. A tap on a result calls `add` and then `onAdded(id)`.
4. The error `network` shows "Search needs a connection" and the text "Trades for assets that you already hold work offline." The error `rate_limited` shows "Too many searches. Wait a minute." The error `server` shows "Search is not available now."

In `TradeForm.test.tsx`:

1. A new trade shows Buy selected, the date of today, and the close of that date as the price, if one exists.
2. A change of the date changes the price to the close of the new date, if the user did not type a price.
3. Save with valid values calls `saveTrade` and closes the form.
4. A sell of 15 with 12 held shows "You hold 12 ACME on 31 Oct 2026. You cannot sell 15." and Save is disabled.
5. Edit mode shows a Delete button that asks for confirmation and calls `deleteTrade`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- AddInstrument.test.tsx TradeForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Write the screens and the routes. Use the input and error styles of `app/src/ui/screens/TransactionForm.tsx`. After `onAdded`, the route goes to `/trade/new?instrument=<id>`. The new instrument shows in the list after sync, and its price shows after the next worker pass.

- [ ] **Step 4: Run the tests**

Run: `npm --workspace app test -- AddInstrument.test.tsx TradeForm.test.tsx`
Expected: PASS.

### Task 16: Exclude from net worth switch

**Files:**
- Modify: `app/src/ui/screens/Accounts.tsx`
- Test: `app/src/ui/screens/CategoriesAccounts.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

In `CategoriesAccounts.test.tsx`, assert that the account form has a switch "Exclude from net worth" with the hint "Use this for money that you moved to a broker. The Portfolio tab counts it as holdings." Turn it on and save. Assert that `saveAccount` gets `exclude_from_net_worth: true`. An existing account with the flag opens with the switch on.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- CategoriesAccounts.test.tsx -t "net worth"`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Add the switch to `AccountFormBody` in `Accounts.tsx`, with the switch style of `app/src/ui/screens/Settings.tsx`.

- [ ] **Step 4: Run the tests**

Run: `make test-app`
Expected: PASS.

### Task 17: E2E and operations

**Files:**
- Modify: `deploy/compose/docker-compose.e2e.yml`, `docs/operations.md`, `e2e/ios/run.ts`
- Create: `e2e/web/portfolio.spec.ts`, `app/e2e/maestro/portfolio.yaml`
- Type: both

- [ ] **Step 1: Set the fake prices in the e2e stack**

In `deploy/compose/docker-compose.e2e.yml`, add `PRICES_FAKE: "1"` and `PRICES_INTERVAL: "2s"` to the `api` environment, with a comment like the `AI_FAKE` comment.

- [ ] **Step 2: Write the web test**

In `e2e/web/portfolio.spec.ts`, with the helpers of `e2e/web/fixtures.ts`:

1. Log in a new user (app currency EUR) and open the Portfolio tab. Expect "No assets yet".
2. Add the asset "acme", then enter buy 10 at 80 fee 1, buy 5 at 90 fee 0 and sell 4 at 100 fee 0, all on dates in the past.
3. Wait for the worker. The fake price is 100 USD and the fake rate is 1.25, so expect the value "€880.00" on the ACME row, and the realized profit "$79.60" on the detail screen.
4. With `query` from `e2e/support/db.ts`, assert 3 `trades` rows for the user.

Run: `make e2e-stack-up && make e2e-web`
Expected: all specs pass.

- [ ] **Step 3: Write the iOS flow**

Add `app/e2e/maestro/portfolio.yaml` with the same steps as the web test, but only one buy. Call it from `main` in `e2e/ios/run.ts` on the phone, after the existing flows, with `maestro(phone, "portfolio.yaml")`.

Run: `make e2e-ios`
Expected: all flows pass.

- [ ] **Step 4: Write the operations notes**

In `docs/operations.md`, add a "Prices" section:

- The worker runs in `mtapi serve`. The settings are `PRICES_ENABLED`, `PRICES_SOURCE_URL`, `PRICES_INTERVAL` and `PRICES_FAKE`, with their defaults.
- The API pod needs outbound HTTPS to `query1.finance.yahoo.com`. A future egress rule must allow it.
- Yahoo has no official API. If its endpoints change, the app shows "Price from ..." on all holdings and the log has "price fetch failed". The fix is a new adapter behind `PriceSource`.
- To fetch an instrument again, set its `last_attempt_at`, `failed_at` and `fail_count` back to null and 0 in Postgres.

- [ ] **Step 5: Run all checks**

Run: `make check-generated && make test`
Expected: exit 0.
