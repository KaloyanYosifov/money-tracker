package insights

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCheckNumbers(t *testing.T) {
	input := []byte(`{"today":"2026-11-16","currency_code":"EUR","holdings":[{"value":"1234.56","weight":"42.5","open_profit":"-12.30"},{"value":"80.50","weight":"100.0","open_profit":"10.00"}],"months":[{"month":"2026-10"}]}`)
	tests := []struct {
		name  string
		title string
		body  string
		bad   string
	}{
		{name: "no numbers", title: "Spread your holdings", body: "One holding is most of the portfolio."},
		{name: "input numbers", title: "Large holding", body: "It is worth 1234.56, which is 42.5% of the total."},
		{name: "unknown number", title: "Large holding", body: "It is worth 1234.57.", bad: "1234.57"},
		{name: "thousands separator", title: "Large holding", body: "It is worth 1,234.56.", bad: "1,234.56"},
		{name: "small integers", title: "Few holdings", body: "You have 3 holdings over 12 months."},
		{name: "integer above 12", title: "Many holdings", body: "You have 13 holdings.", bad: "13"},
		{name: "token of a date", title: "Fees in 2026", body: "Fees are low."},
		{name: "end of sentence", title: "Large holding", body: "Its weight is 42.5."},
		{name: "fraction zeros dropped", title: "One holding", body: "It is 100% of the total and worth 80.5."},
		{name: "fraction zeros added", title: "Large holding", body: "Its weight is 42.50%."},
		{name: "different value", title: "Large holding", body: "Its weight is 42.05%.", bad: "42.05"},
		{name: "unknown number in title", title: "Worth 1234.57", body: "No numbers here.", bad: "1234.57"},
		{name: "negative from the input", title: "A loss", body: "The open profit is -12.30 EUR."},
		{name: "loss without the sign", title: "A loss", body: "You have a loss of 12.30 EUR."},
		{name: "invented minus sign", title: "Large holding", body: "It is worth -1234.56 EUR.", bad: "-1234.56"},
		{name: "date in the text", title: "October", body: "In 2026-10 you invested nothing."},
		{name: "small invented percent", title: "Limit", body: "Keep one holding under 5%.", bad: "5"},
		{name: "small invented amount", title: "Fees", body: "Fees above 7 EUR are high.", bad: "7"},
		{name: "small amount from the input", title: "Profit", body: "The open profit is 10 EUR, or 10%."},
		{name: "unicode minus", title: "A loss", body: "The open profit is \u221212.30 EUR."},
		{name: "unicode minus on a gain", title: "A loss", body: "The open profit is \u221210 EUR.", bad: "\u221210"},
		{name: "plus on a loss", title: "A gain", body: "The open profit is +12.30 EUR.", bad: "12.30"},
		{name: "plus on a gain", title: "A gain", body: "The open profit is +10 EUR."},
		{name: "currency code before a small number", title: "Fees", body: "Fees were EUR 7 this year.", bad: "7"},
		{name: "currency sign before a small number", title: "Fees", body: "Fees were \u20ac7 this year.", bad: "7"},
		{name: "small number with the word percent", title: "Limit", body: "Keep one holding under 5 percent.", bad: "5"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := checkNumbers(Card{Kind: KindTip, Title: tt.title, Body: tt.body, Fingerprint: "fp"}, input)
			if tt.bad == "" {
				if err != nil {
					t.Fatalf("checkNumbers: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("checkNumbers passed, want an error for %q", tt.bad)
			}
			if !strings.Contains(err.Error(), tt.bad) {
				t.Fatalf("error %q does not name %q", err, tt.bad)
			}
		})
	}
}

func TestNumberSource(t *testing.T) {
	value := "10.00"
	in := PortfolioInput{
		Today:       "2026-11-16",
		Summary:     "Last time the total was 777.77.",
		Holdings:    []PortfolioHolding{{Symbol: "AAA", Name: "Synthetic Fund 2030", Value: &value}},
		RecentCards: []InputCard{{Kind: KindTip, Title: "Worth 555.55", Fingerprint: "portfolio:444"}},

		DismissedFingerprints: []string{"portfolio:333"},
	}
	numbers, err := numberSource(in)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkNumbers(Card{Kind: KindTip, Title: "Value", Body: "AAA is worth 10.00."}, numbers); err != nil {
		t.Errorf("computed number: %v", err)
	}
	for _, n := range []string{"777.77", "2030", "555.55", "444", "333"} {
		if err := checkNumbers(Card{Kind: KindTip, Title: "Value", Body: "It is " + n + "."}, numbers); err == nil {
			t.Errorf("checkNumbers passed %s, want an error", n)
		}
	}
	if in.Holdings[0].Name != "Synthetic Fund 2030" {
		t.Errorf("numberSource changed the input name to %q", in.Holdings[0].Name)
	}
}

func TestCheckPortfolioCard(t *testing.T) {
	numbers := []byte(`{"value":"10.00"}`)
	budget := Card{Kind: KindBudget, Title: "Budget", Body: "Set a budget.", Fingerprint: "portfolio:budget",
		Action: json.RawMessage(`{"category_id":"00000000-0000-4000-8000-000000000001","amount_minor":100}`)}
	if err := checkPortfolioCard(budget, numbers, nil, map[string]bool{}); err == nil || !strings.Contains(err.Error(), `kind "budget" is not "tip"`) {
		t.Errorf("budget card error = %v, want the kind error", err)
	}
	tip := Card{Kind: KindTip, Title: "Value", Body: "It is worth 10.00.", Fingerprint: "portfolio:value", Action: json.RawMessage("null")}
	if err := checkPortfolioCard(tip, numbers, nil, map[string]bool{}); err != nil {
		t.Errorf("tip card: %v", err)
	}
	if err := checkPortfolioCard(tip, numbers, []string{"portfolio:value"}, map[string]bool{}); err == nil {
		t.Error("dismissed tip card passed")
	}
}
