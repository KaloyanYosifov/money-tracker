package insights

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"regexp"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/portfolio"
)

// maxNameLength is the length that an instrument name is cut to. The name
// comes from Yahoo and is third-party text.
const maxNameLength = 60

// maxHoldings is the number of holdings that the input lists one by one. The
// other holdings go into one total, so a large portfolio keeps the prompt small.
const maxHoldings = 25

// The symbol and the currency also come from Yahoo. An instrument with other
// text in them is left out of the input.
var (
	safeSymbol   = regexp.MustCompile(`^[A-Za-z0-9.^=&-]{1,20}$`)
	safeCurrency = regexp.MustCompile(`^[A-Za-z]{3}$`)
)

// PortfolioInput is the data of one user that the portfolio_insights task
// gets. Amounts are decimal strings in the app currency with the fraction
// digits of that currency. Shares and weights are percents with 1 fraction digit.
type PortfolioInput struct {
	Today                 string              `json:"today"`
	CurrencyCode          string              `json:"currency_code"`
	Summary               string              `json:"summary"`
	Holdings              []PortfolioHolding  `json:"holdings"`
	CurrencyExposure      []PortfolioExposure `json:"currency_exposure"`
	FeesThisYear          *string             `json:"fees_this_year"`
	Months                []PortfolioMonth    `json:"months"`
	OtherHoldings         *PortfolioOther     `json:"other_holdings"`
	StalePrices           []string            `json:"stale_prices"`
	RecentCards           []InputCard         `json:"recent_cards"`
	DismissedFingerprints []string            `json:"dismissed_fingerprints"`
}

// PortfolioHolding is an open holding in the gateway input. A nil value is
// unknown.
type PortfolioHolding struct {
	Symbol        string  `json:"symbol"`
	Name          string  `json:"name"`
	Kind          string  `json:"kind"`
	QuoteCurrency string  `json:"quote_currency"`
	Value         *string `json:"value"`
	Weight        *string `json:"weight"`
	OpenProfit    *string `json:"open_profit"`
	OpenProfitPct *string `json:"open_profit_pct"`
	LastTradeDate *string `json:"last_trade_date"`
	LastCloseDate *string `json:"last_close_date"`
}

// PortfolioOther is the total of the holdings after the first maxHoldings.
type PortfolioOther struct {
	Count  int     `json:"count"`
	Value  *string `json:"value"`
	Weight *string `json:"weight"`
}

// PortfolioExposure is the share of the portfolio value in one currency.
type PortfolioExposure struct {
	Currency string `json:"currency"`
	Share    string `json:"share"`
}

// PortfolioMonth is the money saved and invested in one month.
type PortfolioMonth struct {
	Month    string  `json:"month"`
	Saved    string  `json:"saved"`
	Invested *string `json:"invested"`
}

// portfolioUsers returns the ids of the users with insights_enabled and at
// least one trade or swap on or before today.
func portfolioUsers(ctx context.Context, pool *pgxpool.Pool, today string) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT s.user_id::text FROM user_settings s
		 WHERE s.insights_enabled
		   AND (EXISTS (SELECT 1 FROM trades t WHERE t.user_id = s.user_id AND t.date <= $1::date)
		     OR EXISTS (SELECT 1 FROM swaps w WHERE w.user_id = s.user_id AND w.date <= $1::date))
		 ORDER BY s.user_id`, today)
	if err != nil {
		return nil, fmt.Errorf("list portfolio users: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func optionalAmount(v *big.Int, digits int) *string {
	if v == nil {
		return nil
	}
	s := portfolio.FormatAmount(v, digits)
	return &s
}

// otherHoldings is the count, the value and the weight of the holdings after
// the first maxHoldings. The value and the weight are nil when one of those
// holdings has no value.
func otherHoldings(holdings []portfolio.HoldingFacts, digits int) *PortfolioOther {
	other := &PortfolioOther{Count: len(holdings) - maxHoldings}
	rest, total := new(big.Int), new(big.Int)
	for n, h := range holdings {
		if h.ValueApp == nil {
			if n >= maxHoldings {
				return other
			}
			continue
		}
		total.Add(total, h.ValueApp)
		if n >= maxHoldings {
			rest.Add(rest, h.ValueApp)
		}
	}
	other.Value = optionalAmount(rest, digits)
	if weight, ok := portfolio.FormatPercent(rest, total); ok {
		other.Weight = &weight
	}
	return other
}

func optionalDate(d string) *string {
	if d == "" {
		return nil
	}
	return &d
}

// cutName keeps letters, digits and the characters " .,&'()/+-" of name,
// joins the spaces and cuts the result to maxNameLength runes.
func cutName(name string) string {
	safe := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune(".,&'()/+-", r) {
			return r
		}
		return ' '
	}, name)
	r := []rune(strings.Join(strings.Fields(safe), " "))
	if len(r) > maxNameLength {
		r = r[:maxNameLength]
	}
	return string(r)
}

// readPortfolioData builds the gateway input of one user for the day today.
func readPortfolioData(ctx context.Context, pool *pgxpool.Pool, userID, today string) (PortfolioInput, error) {
	in := PortfolioInput{Today: today}

	err := pool.QueryRow(ctx, `SELECT currency_code FROM user_settings WHERE user_id = $1`, userID).Scan(&in.CurrencyCode)
	if err != nil {
		return in, fmt.Errorf("read settings: %w", err)
	}

	type instrumentRow struct {
		ID, Symbol, Name, Kind, QuoteCurrency string
	}
	rows, err := pool.Query(ctx,
		`SELECT i.id::text, i.symbol, i.name, i.kind, i.quote_currency
		 FROM user_instruments ui JOIN instruments i ON i.id = ui.instrument_id
		 WHERE ui.user_id = $1 ORDER BY i.symbol`, userID)
	if err != nil {
		return in, fmt.Errorf("read instruments: %w", err)
	}
	instruments, err := pgx.CollectRows(rows, pgx.RowToStructByPos[instrumentRow])
	if err != nil {
		return in, fmt.Errorf("read instruments: %w", err)
	}

	trades := map[string][]portfolio.Trade{}
	rows, err = pool.Query(ctx,
		`SELECT id::text, instrument_id::text, side, date::text, quantity, price, fee
		 FROM trades WHERE user_id = $1 ORDER BY date, id`, userID)
	if err != nil {
		return in, fmt.Errorf("read trades: %w", err)
	}
	var instrumentID string
	var trade portfolio.Trade
	_, err = pgx.ForEachRow(rows, []any{&trade.ID, &instrumentID, &trade.Side, &trade.Date, &trade.Quantity, &trade.Price, &trade.Fee},
		func() error {
			trades[instrumentID] = append(trades[instrumentID], trade)
			return nil
		})
	if err != nil {
		return in, fmt.Errorf("read trades: %w", err)
	}

	rows, err = pool.Query(ctx,
		`SELECT id::text, from_instrument_id::text, to_instrument_id::text, date::text, from_quantity, to_quantity, fee, value, to_value
		 FROM swaps WHERE user_id = $1`, userID)
	if err != nil {
		return in, fmt.Errorf("read swaps: %w", err)
	}
	var toInstrumentID string
	var swap portfolio.Swap
	_, err = pgx.ForEachRow(rows,
		[]any{&swap.ID, &instrumentID, &toInstrumentID, &swap.Date, &swap.FromQuantity, &swap.ToQuantity, &swap.Fee, &swap.Value, &swap.ToValue},
		func() error {
			sell, buy := portfolio.SwapLegs(swap)
			trades[instrumentID] = append(trades[instrumentID], sell)
			trades[toInstrumentID] = append(trades[toInstrumentID], buy)
			return nil
		})
	if err != nil {
		return in, fmt.Errorf("read swaps: %w", err)
	}

	closes := map[string][]portfolio.Close{}
	rows, err = pool.Query(ctx,
		`SELECT p.instrument_id::text, p.date::text, p.close
		 FROM instrument_prices p JOIN user_instruments ui ON ui.instrument_id = p.instrument_id
		 WHERE ui.user_id = $1 AND p.date <= $2::date ORDER BY p.date`, userID, today)
	if err != nil {
		return in, fmt.Errorf("read closes: %w", err)
	}
	var c portfolio.Close
	_, err = pgx.ForEachRow(rows, []any{&instrumentID, &c.Date, &c.Close}, func() error {
		closes[instrumentID] = append(closes[instrumentID], c)
		return nil
	})
	if err != nil {
		return in, fmt.Errorf("read closes: %w", err)
	}

	// The FX pair of a quote currency has the same symbol as fxPair in
	// app/src/data/portfolio.ts.
	fxPairs := map[string]string{}
	for _, i := range instruments {
		if i.Kind == "fx" {
			fxPairs[i.Symbol] = i.ID
		}
	}
	var list []portfolio.Instrument
	for _, i := range instruments {
		if i.Kind == "fx" || len(trades[i.ID]) == 0 {
			continue
		}
		if !safeSymbol.MatchString(i.Symbol) || !safeCurrency.MatchString(i.QuoteCurrency) {
			slog.Warn("portfolio insights instrument skipped", "user_id", userID, "instrument_id", i.ID)
			continue
		}
		list = append(list, portfolio.Instrument{
			Symbol:        i.Symbol,
			Name:          i.Name,
			Kind:          i.Kind,
			QuoteCurrency: i.QuoteCurrency,
			Trades:        trades[i.ID],
			Closes:        closes[i.ID],
			FXCloses:      closes[fxPairs[in.CurrencyCode+i.QuoteCurrency+"=X"]],
		})
	}
	facts := portfolio.BuildFacts(list, in.CurrencyCode, today)
	digits := portfolio.MinorUnits(in.CurrencyCode)

	in.Holdings = []PortfolioHolding{}
	listed := map[string]bool{}
	for n, h := range facts.Holdings {
		if n == maxHoldings {
			in.OtherHoldings = otherHoldings(facts.Holdings, digits)
			break
		}
		listed[h.Symbol] = true
		in.Holdings = append(in.Holdings, PortfolioHolding{
			Symbol:        h.Symbol,
			Name:          cutName(h.Name),
			Kind:          h.Kind,
			QuoteCurrency: h.QuoteCurrency,
			Value:         optionalAmount(h.ValueApp, digits),
			Weight:        h.Weight,
			OpenProfit:    optionalAmount(h.OpenProfitApp, digits),
			OpenProfitPct: h.OpenProfitPct,
			LastTradeDate: optionalDate(h.LastTradeDate),
			LastCloseDate: optionalDate(h.LastCloseDate),
		})
	}
	in.CurrencyExposure = []PortfolioExposure{}
	for _, e := range facts.CurrencyExposure {
		in.CurrencyExposure = append(in.CurrencyExposure, PortfolioExposure{Currency: e.Currency, Share: e.Share})
	}
	in.FeesThisYear = optionalAmount(facts.FeesThisYear, digits)
	in.StalePrices = []string{}
	for _, symbol := range facts.Stale {
		if listed[symbol] {
			in.StalePrices = append(in.StalePrices, symbol)
		}
	}

	saved := map[string]int64{}
	rows, err = pool.Query(ctx,
		`SELECT to_char(date, 'YYYY-MM'),
		        sum(CASE WHEN type = 'income' THEN amount_minor ELSE -amount_minor END)::bigint
		 FROM transactions
		 WHERE user_id = $1 AND type IN ('income', 'expense') AND date >= $2::date AND date <= $3::date
		 GROUP BY 1`, userID, facts.Invested[0].Month+"-01", today)
	if err != nil {
		return in, fmt.Errorf("read saved: %w", err)
	}
	var month string
	var total int64
	_, err = pgx.ForEachRow(rows, []any{&month, &total}, func() error {
		saved[month] = total
		return nil
	})
	if err != nil {
		return in, fmt.Errorf("read saved: %w", err)
	}
	minorScale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(12-digits)), nil)
	for _, m := range facts.Invested {
		in.Months = append(in.Months, PortfolioMonth{
			Month:    m.Month,
			Saved:    portfolio.FormatAmount(new(big.Int).Mul(big.NewInt(saved[m.Month]), minorScale), digits),
			Invested: optionalAmount(m.Amount, digits),
		})
	}

	rows, err = pool.Query(ctx,
		`SELECT kind, title, fingerprint, status FROM insights
		 WHERE user_id = $1 AND source = $2 ORDER BY created_at`, userID, SourcePortfolio)
	if err != nil {
		return in, fmt.Errorf("read cards: %w", err)
	}
	in.RecentCards, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputCard])
	if err != nil {
		return in, fmt.Errorf("read cards: %w", err)
	}

	if in.DismissedFingerprints, err = dismissedFingerprints(ctx, pool, userID, SourcePortfolio); err != nil {
		return in, err
	}
	if in.Summary, err = readMemory(ctx, pool, userID, SourcePortfolio); err != nil {
		return in, err
	}
	return in, nil
}
