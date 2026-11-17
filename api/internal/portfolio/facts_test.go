package portfolio_test

import (
	"math/big"
	"reflect"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/portfolio"
)

func fixedString(v *big.Int) string {
	if v == nil {
		return "<nil>"
	}
	return portfolio.FormatFixed(v)
}

func percentString(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestBuildFacts(t *testing.T) {
	usd := []portfolio.Close{{Date: "2026-09-01", Close: "1.25"}, {Date: "2025-12-30", Close: "1.1"}}
	instruments := []portfolio.Instrument{
		{
			Symbol: "AAA", Name: "Alpha Test", Kind: "stock", QuoteCurrency: "EUR",
			Trades: []portfolio.Trade{
				{ID: "a2", Side: "buy", Date: "2026-11-02", Quantity: "5", Price: "110", Fee: "0.5"},
				{ID: "a1", Side: "buy", Date: "2026-06-10", Quantity: "10", Price: "100", Fee: "1"},
			},
			Closes: []portfolio.Close{{Date: "2026-11-09", Close: "120"}, {Date: "2026-11-02", Close: "110"}},
		},
		{
			Symbol: "BBB", Name: "Beta Test", Kind: "etf", QuoteCurrency: "USD",
			Trades:   []portfolio.Trade{{ID: "b1", Side: "buy", Date: "2026-09-15", Quantity: "4", Price: "150", Fee: "2"}},
			Closes:   []portfolio.Close{{Date: "2026-11-05", Close: "200"}},
			FXCloses: usd,
		},
		{
			Symbol: "CCC", Name: "Gamma Test", Kind: "stock", QuoteCurrency: "USD",
			Trades: []portfolio.Trade{
				{ID: "c1", Side: "buy", Date: "2025-12-31", Quantity: "2", Price: "55", Fee: "1.1"},
				{ID: "c2", Side: "sell", Date: "2026-10-20", Quantity: "2", Price: "75", Fee: "2.5"},
			},
			Closes:   []portfolio.Close{{Date: "2026-11-16", Close: "80"}},
			FXCloses: usd,
		},
		{
			Symbol: "DDD", Name: "Delta Test", Kind: "stock", QuoteCurrency: "GBP",
			Trades: []portfolio.Trade{{ID: "d1", Side: "buy", Date: "2026-08-03", Quantity: "1", Price: "10", Fee: "0"}},
		},
		{
			Symbol: "FFF", Name: "Foxtrot Test", Kind: "stock", QuoteCurrency: "EUR",
			Trades: []portfolio.Trade{
				{ID: "f1", Side: "buy", Date: "2025-01-02", Quantity: "3", Price: "20", Fee: "0"},
				{ID: "f2", Side: "sell", Date: "2025-02-03", Quantity: "3", Price: "25", Fee: "0"},
			},
			Closes: []portfolio.Close{{Date: "2025-02-03", Close: "25"}},
		},
		{
			Symbol: "EURUSD=X", Name: "EUR/USD", Kind: "fx", QuoteCurrency: "USD",
			Trades: []portfolio.Trade{{ID: "e1", Side: "buy", Date: "2026-11-10", Quantity: "1", Price: "1", Fee: "100"}},
		},
	}

	facts := portfolio.BuildFacts(instruments, "EUR", "2026-11-16")

	type holding struct {
		Symbol, ValueApp, OpenProfitApp, Weight, OpenProfitPct, LastTradeDate, LastCloseDate string
	}
	var holdings []holding
	for _, h := range facts.Holdings {
		holdings = append(holdings, holding{
			Symbol:        h.Symbol,
			ValueApp:      fixedString(h.ValueApp),
			OpenProfitApp: fixedString(h.OpenProfitApp),
			Weight:        percentString(h.Weight),
			OpenProfitPct: percentString(h.OpenProfitPct),
			LastTradeDate: h.LastTradeDate,
			LastCloseDate: h.LastCloseDate,
		})
	}
	wantHoldings := []holding{
		{"AAA", "1800", "248.5", "73.8", "16.0", "2026-11-02", "2026-11-09"},
		{"BBB", "640", "158.4", "26.2", "32.9", "2026-09-15", "2026-11-05"},
		{"DDD", "<nil>", "<nil>", "<nil>", "<nil>", "2026-08-03", ""},
	}
	if !reflect.DeepEqual(holdings, wantHoldings) {
		t.Errorf("holdings = %+v, want %+v", holdings, wantHoldings)
	}
	if h := facts.Holdings[0]; h.Name != "Alpha Test" || h.Kind != "stock" || h.QuoteCurrency != "EUR" {
		t.Errorf("holding fields = %+v", h)
	}

	wantExposure := []portfolio.Exposure{{Currency: "EUR", Share: "73.8"}, {Currency: "USD", Share: "26.2"}}
	if !reflect.DeepEqual(facts.CurrencyExposure, wantExposure) {
		t.Errorf("exposure = %+v, want %+v", facts.CurrencyExposure, wantExposure)
	}

	if got := fixedString(facts.FeesThisYear); got != "5.1" {
		t.Errorf("fees this year = %s, want 5.1", got)
	}

	var invested [][2]string
	for _, m := range facts.Invested {
		invested = append(invested, [2]string{m.Month, fixedString(m.Amount)})
	}
	wantInvested := [][2]string{
		{"2026-06", "1001"},
		{"2026-07", "0"},
		{"2026-08", "<nil>"},
		{"2026-09", "481.6"},
		{"2026-10", "-118"},
		{"2026-11", "550.5"},
	}
	if !reflect.DeepEqual(invested, wantInvested) {
		t.Errorf("invested = %v, want %v", invested, wantInvested)
	}

	if want := []string{"BBB", "DDD"}; !reflect.DeepEqual(facts.Stale, want) {
		t.Errorf("stale = %v, want %v", facts.Stale, want)
	}
}

func TestBuildFactsInvestedAcrossYears(t *testing.T) {
	facts := portfolio.BuildFacts(nil, "EUR", "2026-02-28")
	var months []string
	for _, m := range facts.Invested {
		months = append(months, m.Month)
	}
	want := []string{"2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"}
	if !reflect.DeepEqual(months, want) {
		t.Errorf("months = %v, want %v", months, want)
	}
}

func TestBuildFactsZeroCost(t *testing.T) {
	instruments := []portfolio.Instrument{{
		Symbol: "GGG", Name: "Golf Test", Kind: "stock", QuoteCurrency: "EUR",
		Trades: []portfolio.Trade{{ID: "g1", Side: "buy", Date: "2026-11-02", Quantity: "2", Price: "0", Fee: "0"}},
		Closes: []portfolio.Close{{Date: "2026-11-10", Close: "5"}},
	}}
	facts := portfolio.BuildFacts(instruments, "EUR", "2026-11-16")
	if len(facts.Holdings) != 1 {
		t.Fatalf("holdings = %+v", facts.Holdings)
	}
	h := facts.Holdings[0]
	if fixedString(h.ValueApp) != "10" || fixedString(h.OpenProfitApp) != "10" {
		t.Errorf("value, open profit = %s, %s, want 10, 10", fixedString(h.ValueApp), fixedString(h.OpenProfitApp))
	}
	if h.OpenProfitPct != nil {
		t.Errorf("open profit pct = %q, want nil for a zero cost", *h.OpenProfitPct)
	}
}

func TestBuildFactsFeeWithoutRate(t *testing.T) {
	instruments := []portfolio.Instrument{
		{
			Symbol: "JJJ", Name: "Juliet Test", Kind: "stock", QuoteCurrency: "USD",
			Trades: []portfolio.Trade{{ID: "j1", Side: "buy", Date: "2026-10-07", Quantity: "1", Price: "10", Fee: "0.5"}},
		},
		{
			Symbol: "HHH", Name: "Hotel Test", Kind: "stock", QuoteCurrency: "EUR",
			Trades: []portfolio.Trade{{ID: "h1", Side: "buy", Date: "2026-10-12", Quantity: "1", Price: "10", Fee: "1"}},
		},
	}
	facts := portfolio.BuildFacts(instruments, "EUR", "2026-11-16")
	if facts.FeesThisYear != nil {
		t.Errorf("fees this year = %s, want nil when a fee has no rate", fixedString(facts.FeesThisYear))
	}
	for _, m := range facts.Invested {
		if m.Month == "2026-10" && m.Amount != nil {
			t.Errorf("invested 2026-10 = %s, want nil when a trade has no rate", fixedString(m.Amount))
		}
	}
}

func TestBuildFactsUsesTradeDateRate(t *testing.T) {
	instruments := []portfolio.Instrument{{
		Symbol: "MMM", Name: "Mike Test", Kind: "etf", QuoteCurrency: "USD",
		Trades:   []portfolio.Trade{{ID: "m1", Side: "buy", Date: "2026-09-15", Quantity: "4", Price: "150", Fee: "2"}},
		Closes:   []portfolio.Close{{Date: "2026-11-13", Close: "160"}},
		FXCloses: []portfolio.Close{{Date: "2026-09-01", Close: "1.25"}, {Date: "2026-11-10", Close: "2"}},
	}}
	facts := portfolio.BuildFacts(instruments, "EUR", "2026-11-16")
	for _, m := range facts.Invested {
		if m.Month == "2026-09" && fixedString(m.Amount) != "481.6" {
			t.Errorf("invested 2026-09 = %s, want 481.6 at the rate of the trade date", fixedString(m.Amount))
		}
	}
	if got := fixedString(facts.FeesThisYear); got != "1.6" {
		t.Errorf("fees this year = %s, want 1.6 at the rate of the trade date", got)
	}
}

func TestBuildFactsOpenProfitPctWithoutRate(t *testing.T) {
	instruments := []portfolio.Instrument{{
		Symbol: "KKK", Name: "Kilo Test", Kind: "stock", QuoteCurrency: "USD",
		Trades: []portfolio.Trade{{ID: "k1", Side: "buy", Date: "2026-11-02", Quantity: "2.5", Price: "80", Fee: "1"}},
		Closes: []portfolio.Close{{Date: "2026-11-13", Close: "84.2"}},
	}}
	h := portfolio.BuildFacts(instruments, "EUR", "2026-11-16").Holdings[0]
	if h.ValueApp != nil || h.OpenProfitApp != nil {
		t.Errorf("value, open profit = %s, %s, want nil without a rate", fixedString(h.ValueApp), fixedString(h.OpenProfitApp))
	}
	if got := percentString(h.OpenProfitPct); got != "4.7" {
		t.Errorf("open profit pct = %s, want 4.7 from the quote currency amounts", got)
	}
}

func TestBuildFactsSwapInvestsNothing(t *testing.T) {
	sell, buy := portfolio.SwapLegs(portfolio.Swap{
		ID: "sw1", Date: "2026-10-05", FromQuantity: "1", ToQuantity: "2498", Fee: "2", Value: "2500", ToValue: "2500",
	})
	instruments := []portfolio.Instrument{
		{
			Symbol: "ZZA", Name: "Zulu A Test", Kind: "crypto", QuoteCurrency: "USD",
			Trades: []portfolio.Trade{{ID: "a1", Side: "buy", Date: "2026-09-02", Quantity: "1", Price: "2000", Fee: "0"}, sell},
		},
		{Symbol: "ZZB", Name: "Zulu B Test", Kind: "crypto", QuoteCurrency: "USD", Trades: []portfolio.Trade{buy}},
	}
	facts := portfolio.BuildFacts(instruments, "USD", "2026-11-16")
	for _, m := range facts.Invested {
		if m.Month == "2026-10" && fixedString(m.Amount) != "0" {
			t.Errorf("invested 2026-10 = %s, want 0 for a swap", fixedString(m.Amount))
		}
	}
}
