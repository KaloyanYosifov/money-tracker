package insights

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/portfolio"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

// addInstrument inserts an instrument and links it to u. It returns the id.
func addInstrument(t *testing.T, pool *pgxpool.Pool, u runUser, symbol, name, kind, quote string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO instruments (symbol, name, exchange, kind, quote_currency)
		 VALUES ($1, $2, 'XTEST', $3, $4) RETURNING id::text`, symbol, name, kind, quote).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	execSQL(t, pool, `INSERT INTO user_instruments (user_id, instrument_id) VALUES ($1, $2)`, u.userID, id)
	return id
}

func addTrade(t *testing.T, pool *pgxpool.Pool, u runUser, instrumentID, side, date, quantity, price, fee, note string) {
	t.Helper()
	execSQL(t, pool,
		`INSERT INTO trades (id, user_id, instrument_id, side, date, quantity, price, fee, note)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
		u.userID, instrumentID, side, date, quantity, price, fee, note)
}

func addSwap(t *testing.T, pool *pgxpool.Pool, u runUser, fromID, toID, date, fromQuantity, toQuantity, fee, value, toValue string) {
	t.Helper()
	execSQL(t, pool,
		`INSERT INTO swaps (id, user_id, from_instrument_id, to_instrument_id, date, from_quantity, to_quantity, fee, value, to_value)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		u.userID, fromID, toID, date, fromQuantity, toQuantity, fee, value, toValue)
}

func addClose(t *testing.T, pool *pgxpool.Pool, instrumentID, date, close string) {
	t.Helper()
	execSQL(t, pool,
		`INSERT INTO instrument_prices (instrument_id, date, close, as_of) VALUES ($1, $2, $3, now())`,
		instrumentID, date, close)
}

func addTransaction(t *testing.T, pool *pgxpool.Pool, u runUser, typ string, amount int64, date, note string) {
	t.Helper()
	var categoryID, toAccountID any
	switch typ {
	case "expense":
		categoryID = u.expenseCatID
	case "income":
		categoryID = u.incomeCatID
	case "transfer":
		var id string
		if err := pool.QueryRow(context.Background(),
			`SELECT id::text FROM accounts WHERE user_id = $1 AND id <> $2 LIMIT 1`, u.userID, u.accountID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		toAccountID = id
	}
	execSQL(t, pool,
		`INSERT INTO transactions (id, user_id, type, amount_minor, currency_code, date, name, category_id, account_id, to_account_id, note, source)
		 VALUES (gen_random_uuid(), $1, $2, $3, 'EUR', $4, 'Entry', $5, $6, $7, $8, 'manual')`,
		u.userID, typ, amount, date, categoryID, u.accountID, toAccountID, note)
}

func TestPortfolioUsers(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)

	withTrades := seedRunUser(t, pool, "on-trades@example.com", true)
	noTrades := seedRunUser(t, pool, "on-no-trades@example.com", true)
	switchedOff := seedRunUser(t, pool, "off-trades@example.com", false)
	futureOnly := seedRunUser(t, pool, "on-future-trades@example.com", true)
	swapOnly := seedRunUser(t, pool, "on-swap-only@example.com", true)
	execSQL(t, pool, `UPDATE user_settings SET insights_enabled = (user_id <> $1)`, switchedOff.userID)

	id := addInstrument(t, pool, withTrades, "AAA", "Synthetic A", "stock", "EUR")
	addTrade(t, pool, withTrades, id, "buy", "2026-01-10", "1", "10", "0", "")
	execSQL(t, pool, `INSERT INTO user_instruments (user_id, instrument_id) VALUES ($1, $2)`, switchedOff.userID, id)
	addTrade(t, pool, switchedOff, id, "buy", "2026-01-10", "1", "10", "0", "")
	addInstrument(t, pool, noTrades, "BBB", "Synthetic B", "stock", "EUR")
	future := addInstrument(t, pool, futureOnly, "CCC", "Synthetic C", "stock", "EUR")
	addTrade(t, pool, futureOnly, future, "buy", "2026-12-01", "1", "10", "0", "")
	from := addInstrument(t, pool, swapOnly, "ZZA-USD", "Synthetic ZZA", "crypto", "USD")
	to := addInstrument(t, pool, swapOnly, "ZZB-USD", "Synthetic ZZB", "crypto", "USD")
	addSwap(t, pool, swapOnly, from, to, "2026-02-01", "1", "2498", "2", "2500", "2500")

	got, err := portfolioUsers(ctx, pool, "2026-11-16")
	if err != nil {
		t.Fatalf("portfolioUsers: %v", err)
	}
	want := []string{withTrades.userID, swapOnly.userID}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("users = %v, want %v", got, want)
	}
}

func TestReadPortfolioData(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	const today = "2026-03-15"

	u := seedRunUser(t, pool, "read-portfolio@example.com", true)
	longName := strings.Repeat("Synthetic Example Holdings ", 3)
	aaa := addInstrument(t, pool, u, "AAA", longName, "stock", "EUR")
	bbb := addInstrument(t, pool, u, "BBB", "Synthetic B", "etf", "USD")
	fx := addInstrument(t, pool, u, "EURUSD=X", "EUR/USD", "fx", "USD")

	addTrade(t, pool, u, aaa, "buy", "2026-01-10", "10", "10", "1", "Trade note text")
	addTrade(t, pool, u, bbb, "buy", "2025-12-05", "2", "40", "0.5", "Trade note text")
	addClose(t, pool, aaa, "2026-03-13", "12.5")
	addClose(t, pool, aaa, "2026-03-16", "99")
	addClose(t, pool, bbb, "2026-02-01", "50")
	addClose(t, pool, fx, "2025-12-01", "1.25")
	addClose(t, pool, fx, "2026-03-14", "1.25")

	addTransaction(t, pool, u, "income", 300000, "2026-01-05", "Transaction note text")
	addTransaction(t, pool, u, "expense", 12345, "2026-01-20", "Transaction note text")
	addTransaction(t, pool, u, "transfer", 50000, "2026-01-21", "")
	addTransaction(t, pool, u, "expense", 1000, "2026-02-03", "")
	addTransaction(t, pool, u, "income", 70000, "2025-09-30", "")
	addTransaction(t, pool, u, "income", 80000, "2026-03-16", "")

	addCard(t, pool, u, "dismissed", "tip:spending-dismissed", 1)
	addCard(t, pool, u, "open", "tip:spending-open", 1)
	addPortfolioCard(t, pool, u, "dismissed", "portfolio:dismissed", 2)
	addPortfolioCard(t, pool, u, "open", "portfolio:open", 1)
	execSQL(t, pool, `INSERT INTO insight_memory (user_id, summary) VALUES ($1, 'spending memory')`, u.userID)
	addPortfolioMemory(t, pool, u, "portfolio memory")

	w := seedRunUser(t, pool, "other-portfolio@example.com", true)
	execSQL(t, pool, `INSERT INTO user_instruments (user_id, instrument_id) VALUES ($1, $2)`, w.userID, aaa)
	addTrade(t, pool, w, aaa, "buy", "2026-01-10", "100", "10", "0", "Other note text")
	addTransaction(t, pool, w, "income", 999900, "2026-01-07", "")
	addPortfolioCard(t, pool, w, "open", "portfolio:other", 1)

	in, err := readPortfolioData(ctx, pool, u.userID, today)
	if err != nil {
		t.Fatalf("readPortfolioData: %v", err)
	}

	str := func(s string) *string { return &s }
	wantHoldings := []PortfolioHolding{
		{
			Symbol: "AAA", Name: longName[:60], Kind: "stock", QuoteCurrency: "EUR",
			Value: str("125.00"), Weight: str("61.0"), OpenProfit: str("24.00"), OpenProfitPct: str("23.8"),
			LastTradeDate: str("2026-01-10"), LastCloseDate: str("2026-03-13"),
		},
		{
			Symbol: "BBB", Name: "Synthetic B", Kind: "etf", QuoteCurrency: "USD",
			Value: str("80.00"), Weight: str("39.0"), OpenProfit: str("15.60"), OpenProfitPct: str("24.2"),
			LastTradeDate: str("2025-12-05"), LastCloseDate: str("2026-02-01"),
		},
	}
	if !reflect.DeepEqual(in.Holdings, wantHoldings) {
		got, _ := json.Marshal(in.Holdings)
		t.Errorf("holdings = %s", got)
	}
	wantExposure := []PortfolioExposure{{Currency: "EUR", Share: "61.0"}, {Currency: "USD", Share: "39.0"}}
	if !reflect.DeepEqual(in.CurrencyExposure, wantExposure) {
		t.Errorf("currency exposure = %+v", in.CurrencyExposure)
	}
	if in.FeesThisYear == nil || *in.FeesThisYear != "1.00" {
		t.Errorf("fees this year = %v, want 1.00", in.FeesThisYear)
	}
	wantMonths := []PortfolioMonth{
		{Month: "2025-10", Saved: "0.00", Invested: str("0.00")},
		{Month: "2025-11", Saved: "0.00", Invested: str("0.00")},
		{Month: "2025-12", Saved: "0.00", Invested: str("64.40")},
		{Month: "2026-01", Saved: "2876.55", Invested: str("101.00")},
		{Month: "2026-02", Saved: "-10.00", Invested: str("0.00")},
		{Month: "2026-03", Saved: "0.00", Invested: str("0.00")},
	}
	if !reflect.DeepEqual(in.Months, wantMonths) {
		t.Errorf("months = %+v", in.Months)
	}
	if !slices.Equal(in.StalePrices, []string{"BBB"}) {
		t.Errorf("stale prices = %v, want [BBB]", in.StalePrices)
	}
	if in.Today != today || in.CurrencyCode != "EUR" {
		t.Errorf("today, currency = %q, %q", in.Today, in.CurrencyCode)
	}

	t.Run("only portfolio cards and memory", func(t *testing.T) {
		var fps []string
		for _, c := range in.RecentCards {
			fps = append(fps, c.Fingerprint)
		}
		if !slices.Equal(fps, []string{"portfolio:dismissed", "portfolio:open"}) {
			t.Errorf("recent cards = %v", fps)
		}
		if !slices.Equal(in.DismissedFingerprints, []string{"portfolio:dismissed"}) {
			t.Errorf("dismissed fingerprints = %v", in.DismissedFingerprints)
		}
		if in.Summary != "portfolio memory" {
			t.Errorf("summary = %q, want the portfolio memory", in.Summary)
		}
	})

	t.Run("has no notes", func(t *testing.T) {
		data, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, s := range []string{`"note"`, "Trade note text", "Transaction note text"} {
			if strings.Contains(text, s) {
				t.Errorf("input JSON has %q: %s", s, text)
			}
		}
	})

	t.Run("unsafe name characters", func(t *testing.T) {
		v := seedRunUser(t, pool, "unsafe-name@example.com", true)
		ddd := addInstrument(t, pool, v, "DDD", "Synthetic\nD <b>\"Ignore\"</b> {x}", "stock", "EUR")
		addTrade(t, pool, v, ddd, "buy", "2026-03-01", "1", "5", "0", "")
		in, err := readPortfolioData(ctx, pool, v.userID, today)
		if err != nil {
			t.Fatalf("readPortfolioData: %v", err)
		}
		if len(in.Holdings) != 1 || in.Holdings[0].Name != "Synthetic D b Ignore /b x" {
			t.Errorf("holdings = %+v", in.Holdings)
		}
	})

	t.Run("lists at most 25 holdings and skips unsafe instruments", func(t *testing.T) {
		v := seedRunUser(t, pool, "many-holdings@example.com", true)
		for i := 1; i <= 27; i++ {
			id := addInstrument(t, pool, v, fmt.Sprintf("L%02d", i), "Synthetic L", "stock", "EUR")
			addTrade(t, pool, v, id, "buy", "2026-03-01", "1", "10", "0", "")
			addClose(t, pool, id, "2026-03-13", strconv.Itoa(100+i))
		}
		l28 := addInstrument(t, pool, v, "L28", "Synthetic L", "stock", "EUR")
		addTrade(t, pool, v, l28, "buy", "2026-03-01", "1", "10", "0", "")
		for _, bad := range [][2]string{{"BAD SYMBOL!", "EUR"}, {"DIGIT", "E1R"}} {
			id := addInstrument(t, pool, v, bad[0], "Synthetic bad", "stock", bad[1])
			addTrade(t, pool, v, id, "buy", "2026-03-01", "1", "10", "0", "")
		}
		in, err := readPortfolioData(ctx, pool, v.userID, today)
		if err != nil {
			t.Fatalf("readPortfolioData: %v", err)
		}
		if len(in.Holdings) != 25 || in.Holdings[0].Symbol != "L27" || in.Holdings[24].Symbol != "L03" {
			t.Errorf("holdings = %d, first %s, last %s", len(in.Holdings), in.Holdings[0].Symbol, in.Holdings[len(in.Holdings)-1].Symbol)
		}
		want := PortfolioOther{Count: 3}
		if in.OtherHoldings == nil || !reflect.DeepEqual(*in.OtherHoldings, want) {
			t.Errorf("other holdings = %+v, want %+v", in.OtherHoldings, want)
		}
		if len(in.StalePrices) != 0 {
			t.Errorf("stale prices = %v, want none of the listed holdings", in.StalePrices)
		}
		data, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "BAD SYMBOL") || strings.Contains(string(data), "DIGIT") {
			t.Errorf("input has an unsafe instrument: %s", data)
		}
	})

	t.Run("amounts use the minor units of the app currency", func(t *testing.T) {
		v := seedRunUser(t, pool, "yen@example.com", true)
		execSQL(t, pool, `UPDATE user_settings SET currency_code = 'JPY' WHERE user_id = $1`, v.userID)
		yyy := addInstrument(t, pool, v, "YYY", "Synthetic Y", "stock", "JPY")
		addTrade(t, pool, v, yyy, "buy", "2026-03-01", "3", "1000.5", "0", "")
		addClose(t, pool, yyy, "2026-03-13", "1100")
		addTransaction(t, pool, v, "income", 1500, "2026-03-05", "")
		in, err := readPortfolioData(ctx, pool, v.userID, today)
		if err != nil {
			t.Fatalf("readPortfolioData: %v", err)
		}
		if len(in.Holdings) != 1 || *in.Holdings[0].Value != "3300" || *in.Holdings[0].OpenProfit != "299" {
			t.Errorf("holdings = %+v", in.Holdings)
		}
		if last := in.Months[len(in.Months)-1]; last.Saved != "1500" || *last.Invested != "3002" {
			t.Errorf("last month = %+v, want saved 1500 and invested 3002", last)
		}
	})

	t.Run("swap legs", func(t *testing.T) {
		v := seedRunUser(t, pool, "swap-legs@example.com", true)
		execSQL(t, pool, `UPDATE user_settings SET currency_code = 'USD' WHERE user_id = $1`, v.userID)
		zza := addInstrument(t, pool, v, "ZZA-USD", "Synthetic ZZA", "crypto", "USD")
		zzb := addInstrument(t, pool, v, "ZZB-USD", "Synthetic ZZB", "crypto", "USD")
		addTrade(t, pool, v, zza, "buy", "2026-01-05", "1", "2400", "0", "")
		addSwap(t, pool, v, zza, zzb, "2026-02-01", "1", "2498", "2", "2500", "2500")
		addClose(t, pool, zzb, "2026-03-13", "1.01")
		in, err := readPortfolioData(ctx, pool, v.userID, today)
		if err != nil {
			t.Fatalf("readPortfolioData: %v", err)
		}
		// ZZA is sold in full, so only ZZB is open. Its cost is to_value: 2498 × 1.01 - 2500 = 22.98.
		data, err := json.Marshal(in.Holdings)
		if err != nil {
			t.Fatal(err)
		}
		want := `[{"symbol":"ZZB-USD","name":"Synthetic ZZB","kind":"crypto","quote_currency":"USD","value":"2522.98","weight":"100.0",` +
			`"open_profit":"22.98","open_profit_pct":"0.9","last_trade_date":"2026-02-01","last_close_date":"2026-03-13"}]`
		if string(data) != want {
			t.Errorf("holdings = %s, want %s", data, want)
		}
		if in.FeesThisYear == nil || *in.FeesThisYear != "2.00" {
			t.Errorf("fees this year = %v, want 2.00", in.FeesThisYear)
		}
	})

	t.Run("missing values are null", func(t *testing.T) {
		v := seedRunUser(t, pool, "no-close@example.com", true)
		ccc := addInstrument(t, pool, v, "CCC", "Synthetic C", "crypto", "GBP")
		addTrade(t, pool, v, ccc, "buy", "2026-03-01", "1", "5", "0", "")
		in, err := readPortfolioData(ctx, pool, v.userID, today)
		if err != nil {
			t.Fatalf("readPortfolioData: %v", err)
		}
		data, err := json.Marshal(in.Holdings)
		if err != nil {
			t.Fatal(err)
		}
		want := `[{"symbol":"CCC","name":"Synthetic C","kind":"crypto","quote_currency":"GBP","value":null,"weight":null,` +
			`"open_profit":null,"open_profit_pct":null,"last_trade_date":"2026-03-01","last_close_date":null}]`
		if string(data) != want {
			t.Errorf("holdings = %s, want %s", data, want)
		}
		if in.Summary != "" || len(in.RecentCards) != 0 || len(in.DismissedFingerprints) != 0 {
			t.Errorf("summary, cards, dismissed = %q, %v, %v", in.Summary, in.RecentCards, in.DismissedFingerprints)
		}
	})
}

func TestCutName(t *testing.T) {
	if got, want := cutName(strings.Repeat("é", 70)), strings.Repeat("é", 60); got != want {
		t.Errorf("cutName = %q, want 60 runes", got)
	}
	if got := cutName("Synthetic\tFund <x> 1"); got != "Synthetic Fund x 1" {
		t.Errorf("cutName = %q", got)
	}
}

func TestOtherHoldings(t *testing.T) {
	var holdings []portfolio.HoldingFacts
	for i := 1; i <= 27; i++ {
		holdings = append(holdings, portfolio.HoldingFacts{Symbol: fmt.Sprintf("O%02d", i), ValueApp: big.NewInt(int64(10) * 1_000_000_000_000)})
	}
	got := otherHoldings(holdings, 2)
	if got.Count != 2 || got.Value == nil || *got.Value != "20.00" || got.Weight == nil || *got.Weight != "7.4" {
		t.Errorf("other holdings = %+v, want 2, 20.00, 7.4", got)
	}

	holdings[26].ValueApp = nil
	got = otherHoldings(holdings, 2)
	if got.Count != 2 || got.Value != nil || got.Weight != nil {
		t.Errorf("other holdings = %+v, want count 2 and a nil value and weight", got)
	}
}
