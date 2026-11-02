package prices

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

func execSQL(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// newUser creates a user with the default data and the app currency.
func newUser(t *testing.T, pool *pgxpool.Pool, currency string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx,
		`INSERT INTO users (id, email, password_hash, role)
		 VALUES (gen_random_uuid(), gen_random_uuid()::text || '@example.com', 'x', 'user') RETURNING id::text`).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	if err := users.SeedDefaults(ctx, tx, id, currency); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return id
}

func addInstrument(t *testing.T, pool *pgxpool.Pool, symbol, kind, currency string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO instruments (symbol, name, exchange, kind, quote_currency)
		 VALUES ($1, $1 || ' Test Corp', 'NASDAQ', $2, $3) RETURNING id::text`, symbol, kind, currency).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func linkUser(t *testing.T, pool *pgxpool.Pool, userID, instrumentID string) {
	t.Helper()
	execSQL(t, pool, `INSERT INTO user_instruments (user_id, instrument_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		userID, instrumentID)
}

// addTrade links the instrument to the user and adds a buy on date.
func addTrade(t *testing.T, pool *pgxpool.Pool, userID, instrumentID, date string) {
	t.Helper()
	linkUser(t, pool, userID, instrumentID)
	execSQL(t, pool,
		`INSERT INTO trades (id, user_id, instrument_id, side, date, quantity, price, fee)
		 VALUES (gen_random_uuid(), $1, $2, 'buy', $3, '1', '10', '0')`, userID, instrumentID, date)
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func day(s string) time.Time {
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return d
}

func TestLinkInstrument(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	userID := newUser(t, pool, "EUR")
	chart := Chart{Symbol: "ZZTA", Name: "Zeta Alpha Inc.", Exchange: "NASDAQ", Kind: KindStock, Currency: "USD"}

	first, err := LinkInstrument(ctx, pool, userID, chart, KindStock)
	if err != nil {
		t.Fatalf("LinkInstrument: %v", err)
	}
	want := Instrument{ID: first.ID, Symbol: "ZZTA", Name: "Zeta Alpha Inc.", Exchange: "NASDAQ", Kind: KindStock, QuoteCurrency: "USD"}
	if first.ID == "" || first != want {
		t.Errorf("instrument = %+v, want %+v", first, want)
	}

	second, err := LinkInstrument(ctx, pool, userID, chart, KindStock)
	if err != nil {
		t.Fatalf("second LinkInstrument: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("second id = %s, want %s", second.ID, first.ID)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM instruments WHERE symbol = 'ZZTA'`); n != 1 {
		t.Errorf("instrument rows = %d, want 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM user_instruments WHERE user_id = $1 AND instrument_id = $2`, userID, first.ID); n != 1 {
		t.Errorf("link rows = %d, want 1", n)
	}

	other := newUser(t, pool, "EUR")
	third, err := LinkInstrument(ctx, pool, other, chart, KindStock)
	if err != nil || third.ID != first.ID {
		t.Fatalf("LinkInstrument for a second user = %+v, %v", third, err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM user_instruments WHERE instrument_id = $1`, first.ID); n != 2 {
		t.Errorf("link rows = %d, want 2", n)
	}
}

func TestEnsureFXPairs(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	userID := newUser(t, pool, "EUR")
	linkUser(t, pool, userID, addInstrument(t, pool, "ZZUS", KindStock, "USD"))
	linkUser(t, pool, userID, addInstrument(t, pool, "ZZEU.DE", KindStock, "EUR"))

	if err := EnsureFXPairs(ctx, pool); err != nil {
		t.Fatalf("EnsureFXPairs: %v", err)
	}
	var kind, currency, name string
	err := pool.QueryRow(ctx, `SELECT kind, quote_currency, name FROM instruments WHERE symbol = 'EURUSD=X'`).
		Scan(&kind, &currency, &name)
	if err != nil {
		t.Fatalf("read EURUSD=X: %v", err)
	}
	if kind != KindFX || currency != "USD" || name != "EUR/USD" {
		t.Errorf("EURUSD=X = %s, %s, %s", kind, currency, name)
	}
	linked := `SELECT count(*) FROM user_instruments ui JOIN instruments i ON i.id = ui.instrument_id
	           WHERE ui.user_id = $1 AND i.symbol = $2`
	if n := countRows(t, pool, linked, userID, "EURUSD=X"); n != 1 {
		t.Errorf("EURUSD=X links = %d, want 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM instruments WHERE kind = 'fx'`); n != 1 {
		t.Errorf("fx instruments = %d, want 1 (a EUR instrument needs no pair)", n)
	}

	if err := EnsureFXPairs(ctx, pool); err != nil {
		t.Fatalf("second EnsureFXPairs: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM instruments`); n != 3 {
		t.Errorf("instruments after the second call = %d, want 3", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM user_instruments`); n != 3 {
		t.Errorf("links after the second call = %d, want 3", n)
	}

	execSQL(t, pool, `UPDATE user_settings SET currency_code = 'GBP' WHERE user_id = $1`, userID)
	if err := EnsureFXPairs(ctx, pool); err != nil {
		t.Fatalf("EnsureFXPairs after the currency change: %v", err)
	}
	if n := countRows(t, pool, linked, userID, "GBPUSD=X"); n != 1 {
		t.Errorf("GBPUSD=X links = %d, want 1", n)
	}
	if n := countRows(t, pool, linked, userID, "GBPEUR=X"); n != 1 {
		t.Errorf("GBPEUR=X links = %d, want 1", n)
	}
}

func TestHistoryStart(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	today := day("2026-10-20")
	alice := newUser(t, pool, "EUR")
	bob := newUser(t, pool, "EUR")

	start := func(t *testing.T, symbol string) string {
		t.Helper()
		var inst Instrument
		err := pool.QueryRow(ctx,
			`SELECT id::text, symbol, name, exchange, kind, quote_currency FROM instruments WHERE symbol = $1`, symbol).
			Scan(&inst.ID, &inst.Symbol, &inst.Name, &inst.Exchange, &inst.Kind, &inst.QuoteCurrency)
		if err != nil {
			t.Fatal(err)
		}
		got, err := HistoryStart(ctx, pool, inst, today)
		if err != nil {
			t.Fatalf("HistoryStart: %v", err)
		}
		return got.Format(time.DateOnly)
	}

	t.Run("no trades", func(t *testing.T) {
		addInstrument(t, pool, "ZZNO", KindStock, "USD")
		if got := start(t, "ZZNO"); got != "2026-10-13" {
			t.Errorf("start = %s, want 2026-10-13", got)
		}
	})

	t.Run("stock: earliest trade over all users", func(t *testing.T) {
		id := addInstrument(t, pool, "ZZST", KindStock, "USD")
		addTrade(t, pool, alice, id, "2026-03-05")
		addTrade(t, pool, bob, id, "2025-11-02")
		if got := start(t, "ZZST"); got != "2025-11-02" {
			t.Errorf("start = %s, want 2025-11-02", got)
		}
	})

	t.Run("fx: earliest trade over all instruments with the quote currency", func(t *testing.T) {
		gbp := addInstrument(t, pool, "ZZGB.L", KindStock, "GBP")
		etf := addInstrument(t, pool, "ZZGE.L", KindETF, "GBP")
		addInstrument(t, pool, "EURGBP=X", KindFX, "GBP")
		addTrade(t, pool, alice, gbp, "2026-01-15")
		addTrade(t, pool, bob, etf, "2025-06-30")
		if got := start(t, "EURGBP=X"); got != "2025-06-30" {
			t.Errorf("start = %s, want 2025-06-30", got)
		}
	})

	t.Run("a very old trade starts at the earliest history date", func(t *testing.T) {
		id := addInstrument(t, pool, "ZZOLD", KindStock, "USD")
		addTrade(t, pool, alice, id, "0001-01-01")
		if got := start(t, "ZZOLD"); got != "1970-01-01" {
			t.Errorf("start = %s, want 1970-01-01", got)
		}
	})
}

func TestSavePrices(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	id := addInstrument(t, pool, "ZZSV", KindStock, "USD")
	latestAt := time.Date(2026, 10, 20, 14, 30, 0, 0, time.UTC)

	chart := Chart{
		Symbol: "ZZSV", Currency: "USD",
		Closes: []DailyClose{
			{Date: day("2026-10-16"), Close: "10.5"},
			{Date: day("2026-10-19"), Close: "11"},
			{Date: day("2026-10-20"), Close: "11.2"},
		},
		Latest:   "11.25",
		LatestAt: latestAt,
	}
	if err := SavePrices(ctx, pool, id, chart); err != nil {
		t.Fatalf("SavePrices: %v", err)
	}

	type row struct {
		date, close string
		asOf        time.Time
	}
	read := func(t *testing.T) []row {
		t.Helper()
		rows, err := pool.Query(ctx,
			`SELECT date::text, close, as_of FROM instrument_prices WHERE instrument_id = $1 ORDER BY date`, id)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.date, &r.close, &r.asOf); err != nil {
				t.Fatal(err)
			}
			out = append(out, r)
		}
		return out
	}

	got := read(t)
	if len(got) != 3 {
		t.Fatalf("rows = %+v, want 3", got)
	}
	if got[0].date != "2026-10-16" || got[0].close != "10.5" || got[1].date != "2026-10-19" || got[1].close != "11" {
		t.Errorf("closes = %+v", got[:2])
	}
	if got[2].date != "2026-10-20" || got[2].close != "11.25" || !got[2].asOf.Equal(latestAt) {
		t.Errorf("row of today = %+v, want close 11.25 as of %s", got[2], latestAt)
	}

	chart.Closes = nil
	chart.Latest = "11.4"
	chart.LatestAt = latestAt.Add(time.Hour)
	if err := SavePrices(ctx, pool, id, chart); err != nil {
		t.Fatalf("second SavePrices: %v", err)
	}
	got = read(t)
	if len(got) != 3 {
		t.Fatalf("rows after the second call = %+v, want 3", got)
	}
	if got[2].close != "11.4" || !got[2].asOf.Equal(latestAt.Add(time.Hour)) {
		t.Errorf("row of today = %+v, want close 11.4", got[2])
	}

	chart.Latest = "11.6"
	chart.LatestAt = time.Date(2026, 10, 21, 9, 30, 0, 0, time.FixedZone("", 11*3600))
	if err := SavePrices(ctx, pool, id, chart); err != nil {
		t.Fatalf("third SavePrices: %v", err)
	}
	got = read(t)
	if len(got) != 4 || got[3].date != "2026-10-21" || got[3].close != "11.6" || got[2].close != "11.4" {
		t.Errorf("rows = %+v, want the latest price on the exchange date 2026-10-21", got)
	}
}
