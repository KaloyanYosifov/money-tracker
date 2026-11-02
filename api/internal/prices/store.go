package prices

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is a pool or a transaction.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Instrument struct {
	ID            string
	Symbol        string
	Name          string
	Exchange      string
	Kind          string
	QuoteCurrency string
}

// historyDays is how far back the history of an instrument with no older
// trades starts.
const historyDays = 7

// earliestHistory is the earliest date that the worker fetches, so that a
// trade with a very old date does not fetch the full history.
const earliestHistory = "1970-01-01"

// historyStartSQL gives the history start of the instruments row "i" for the
// date parameter $today: the earliest trade date, but not later than $today
// minus 7 days and not earlier than earliestHistory. For an FX pair it uses
// the trades of all instruments with its quote currency.
func historyStartSQL(today string) string {
	return fmt.Sprintf(`GREATEST(DATE '%[3]s', LEAST(%[1]s::date - %[2]d, COALESCE(
		CASE WHEN i.kind = 'fx' THEN
			(SELECT min(t.date) FROM trades t JOIN instruments ti ON ti.id = t.instrument_id
			 WHERE ti.quote_currency = i.quote_currency AND ti.kind <> 'fx')
		ELSE
			(SELECT min(t.date) FROM trades t WHERE t.instrument_id = i.id)
		END, %[1]s::date - %[2]d)))`, today, historyDays, earliestHistory)
}

// LinkInstrument creates the instrument of chart if it does not exist, and
// links it to the user.
func LinkInstrument(ctx context.Context, db DB, userID string, chart Chart, kind string) (Instrument, error) {
	var inst Instrument
	err := db.QueryRow(ctx,
		`INSERT INTO instruments (symbol, name, exchange, kind, quote_currency)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
		 RETURNING id::text, symbol, name, exchange, kind, quote_currency`,
		chart.Symbol, chart.Name, chart.Exchange, kind, chart.Currency).
		Scan(&inst.ID, &inst.Symbol, &inst.Name, &inst.Exchange, &inst.Kind, &inst.QuoteCurrency)
	if err != nil {
		return Instrument{}, fmt.Errorf("upsert instrument %s: %w", chart.Symbol, err)
	}
	if _, err := db.Exec(ctx,
		`INSERT INTO user_instruments (user_id, instrument_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		userID, inst.ID); err != nil {
		return Instrument{}, fmt.Errorf("link instrument %s: %w", chart.Symbol, err)
	}
	return inst, nil
}

// fxPairsSQL gives the FX pairs that each user needs: the app currency and
// each other quote currency of the instruments of the user.
const fxPairsSQL = `
	SELECT DISTINCT ui.user_id, s.currency_code || i.quote_currency || '=X' AS symbol,
	       s.currency_code || '/' || i.quote_currency AS name, i.quote_currency AS quote
	FROM user_instruments ui
	JOIN instruments i ON i.id = ui.instrument_id AND i.kind <> 'fx'
	JOIN user_settings s ON s.user_id = ui.user_id
	WHERE i.quote_currency <> s.currency_code`

// EnsureFXPairs adds the missing FX pair instruments and links them to the
// users that need them. The links are a second statement, so that they see
// pairs that a concurrent call added.
func EnsureFXPairs(ctx context.Context, db DB) error {
	if _, err := db.Exec(ctx,
		`INSERT INTO instruments (symbol, name, exchange, kind, quote_currency)
		 SELECT DISTINCT p.symbol, p.name, 'CCY', 'fx', p.quote FROM (`+fxPairsSQL+`) p
		 ON CONFLICT (symbol) DO NOTHING`); err != nil {
		return fmt.Errorf("insert fx pairs: %w", err)
	}
	if _, err := db.Exec(ctx,
		`INSERT INTO user_instruments (user_id, instrument_id)
		 SELECT p.user_id, i.id FROM (`+fxPairsSQL+`) p JOIN instruments i ON i.symbol = p.symbol
		 ON CONFLICT DO NOTHING`); err != nil {
		return fmt.Errorf("link fx pairs: %w", err)
	}
	return nil
}

// HistoryStart gives the first date that the prices of inst must cover.
func HistoryStart(ctx context.Context, db DB, inst Instrument, today time.Time) (time.Time, error) {
	var start time.Time
	err := db.QueryRow(ctx,
		`SELECT `+historyStartSQL("$2")+` FROM instruments i WHERE i.id = $1`,
		inst.ID, dayOf(today)).Scan(&start)
	if err != nil {
		return time.Time{}, fmt.Errorf("history start of %s: %w", inst.Symbol, err)
	}
	return start, nil
}

// SavePrices upserts the closes of chart, and the latest price as the close
// of the date of LatestAt in its location (the exchange time zone).
func SavePrices(ctx context.Context, db DB, instrumentID string, chart Chart) error {
	type price struct {
		close string
		asOf  time.Time
	}
	byDate := make(map[time.Time]price, len(chart.Closes)+1)
	for _, c := range chart.Closes {
		d := dayOf(c.Date)
		byDate[d] = price{c.Close, d}
	}
	if chart.Latest != "" && !chart.LatestAt.IsZero() {
		y, m, d := chart.LatestAt.Date()
		byDate[time.Date(y, m, d, 0, 0, 0, 0, time.UTC)] = price{chart.Latest, chart.LatestAt}
	}
	if len(byDate) == 0 {
		return nil
	}

	dates := make([]time.Time, 0, len(byDate))
	for d := range byDate {
		dates = append(dates, d)
	}
	sort.Slice(dates, func(a, b int) bool { return dates[a].Before(dates[b]) })
	closes := make([]string, len(dates))
	asOf := make([]time.Time, len(dates))
	for n, d := range dates {
		closes[n], asOf[n] = byDate[d].close, byDate[d].asOf
	}

	_, err := db.Exec(ctx,
		`INSERT INTO instrument_prices (instrument_id, date, close, as_of)
		 SELECT $1, d, c, a FROM unnest($2::date[], $3::text[], $4::timestamptz[]) AS p(d, c, a)
		 ON CONFLICT (instrument_id, date) DO UPDATE SET close = EXCLUDED.close, as_of = EXCLUDED.as_of`,
		instrumentID, dates, closes, asOf)
	if err != nil {
		return fmt.Errorf("save prices of %s: %w", chart.Symbol, err)
	}
	return nil
}

func dayOf(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
