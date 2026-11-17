package portfolio_test

import (
	"encoding/json"
	"math/big"
	"os"
	"reflect"
	"sort"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/portfolio"
)

type vectorTrade struct {
	ID       string `json:"id"`
	Side     string `json:"side"`
	Date     string `json:"date"`
	Quantity string `json:"quantity"`
	Price    string `json:"price"`
	Fee      string `json:"fee"`
	Total    string `json:"total"`
}

type vectorClose struct {
	Date  string `json:"date"`
	Close string `json:"close"`
}

type vectorRealized struct {
	Date   string `json:"date"`
	Amount string `json:"amount"`
}

type vectorExpect struct {
	Quantity      string           `json:"quantity"`
	Cost          string           `json:"cost"`
	Fees          string           `json:"fees"`
	Realized      []vectorRealized `json:"realized"`
	Rate          *string          `json:"rate"`
	ValueApp      *string          `json:"value_app"`
	OpenProfitApp *string          `json:"open_profit_app"`
}

type vectorCase struct {
	Name          string        `json:"name"`
	QuoteCurrency string        `json:"quote_currency"`
	AppCurrency   string        `json:"app_currency"`
	Trades        []vectorTrade `json:"trades"`
	Closes        []vectorClose `json:"closes"`
	FxCloses      []vectorClose `json:"fx_closes"`
	Today         string        `json:"today"`
	OnDate        string        `json:"on_date"`
	Expect        vectorExpect  `json:"expect"`
}

func closes(in []vectorClose) []portfolio.Close {
	out := make([]portfolio.Close, len(in))
	for i, c := range in {
		out[i] = portfolio.Close{Date: c.Date, Close: c.Close}
	}
	return out
}

func text(v *big.Int) *string {
	if v == nil {
		return nil
	}
	s := portfolio.FormatFixed(v)
	return &s
}

func TestSharedVectors(t *testing.T) {
	data, err := os.ReadFile("../../../testdata/portfolio-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []vectorCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("no cases")
	}

	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			trades := make([]portfolio.Trade, len(c.Trades))
			for i, tr := range c.Trades {
				trades[i] = portfolio.Trade{ID: tr.ID, Side: tr.Side, Date: tr.Date, Quantity: tr.Quantity, Price: tr.Price, Fee: tr.Fee, Total: tr.Total}
			}
			h := portfolio.HoldingOf(trades, c.OnDate)
			rate := portfolio.RateOn(closes(c.FxCloses), c.Today)

			var value, profit *big.Int
			if len(c.Closes) > 0 {
				sorted := append([]vectorClose(nil), c.Closes...)
				sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Date < sorted[j].Date })
				last := fixed(t, sorted[len(sorted)-1].Close)
				v := portfolio.Mul(h.Quantity, last)
				value = portfolio.ToApp(v, c.QuoteCurrency, c.AppCurrency, rate)
				profit = portfolio.ToApp(new(big.Int).Sub(v, h.Cost), c.QuoteCurrency, c.AppCurrency, rate)
			}

			realized := []vectorRealized{}
			for _, r := range h.Realized {
				realized = append(realized, vectorRealized{Date: r.Date, Amount: portfolio.FormatFixed(r.Amount)})
			}
			got := vectorExpect{
				Quantity:      portfolio.FormatFixed(h.Quantity),
				Cost:          portfolio.FormatFixed(h.Cost),
				Fees:          portfolio.FormatFixed(h.Fees),
				Realized:      realized,
				Rate:          text(rate),
				ValueApp:      text(value),
				OpenProfitApp: text(profit),
			}
			if !reflect.DeepEqual(got, c.Expect) {
				gotJSON, _ := json.Marshal(got)
				wantJSON, _ := json.Marshal(c.Expect)
				t.Errorf("got  %s\nwant %s", gotJSON, wantJSON)
			}
		})
	}
}
