package prices

import (
	"context"
	"strings"
	"time"
)

// Fake is a deterministic PriceSource for the e2e stack. It makes no network
// calls.
type Fake struct{}

func NewFake() *Fake { return &Fake{} }

// Search returns one stock with the query in upper case as its symbol.
func (f *Fake) Search(_ context.Context, query string) ([]Match, error) {
	symbol := strings.ToUpper(strings.TrimSpace(query))
	return []Match{{Symbol: symbol, Name: symbol + " Test Corp", Exchange: "NASDAQ", Kind: KindStock}}, nil
}

// Chart returns a close of 100 (1.25 for an FX pair) for each day from the
// date of from to today. The currency is EUR for a .DE symbol, the quote
// currency for an FX pair, else USD.
func (f *Fake) Chart(_ context.Context, symbol string, from time.Time) (Chart, error) {
	c := Chart{
		Symbol:   symbol,
		Name:     symbol + " Test Corp",
		Exchange: "NASDAQ",
		Kind:     KindStock,
		Currency: "USD",
		Latest:   "100",
		LatestAt: time.Now().UTC(),
	}
	switch {
	case strings.HasSuffix(symbol, "=X") && len(symbol) >= 5:
		pair := strings.TrimSuffix(symbol, "=X")
		c.Kind = KindFX
		c.Currency = pair[len(pair)-3:]
		c.Latest = "1.25"
	case strings.HasSuffix(symbol, ".DE"):
		c.Currency = "EUR"
	}

	today := c.LatestAt.UTC().Truncate(24 * time.Hour)
	for d := from.UTC().Truncate(24 * time.Hour); !d.After(today); d = d.AddDate(0, 0, 1) {
		c.Closes = append(c.Closes, DailyClose{Date: d, Close: c.Latest})
	}
	return c, nil
}
