package prices

import (
	"context"
	"testing"
	"time"
)

func TestFakeSearch(t *testing.T) {
	matches, err := NewFake().Search(context.Background(), "acme")
	if err != nil {
		t.Fatal(err)
	}

	want := Match{Symbol: "ACME", Name: "ACME Test Corp", Exchange: "NASDAQ", Kind: KindStock}
	if len(matches) != 1 || matches[0] != want {
		t.Errorf("matches = %+v, want [%+v]", matches, want)
	}
}

func TestFakeChart(t *testing.T) {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	from := today.AddDate(0, 0, -3)

	cases := []struct {
		symbol, name, kind, currency, close string
	}{
		{"ACME", "ACME Test Corp", KindStock, "USD", "100"},
		{"ACME.DE", "ACME.DE Test Corp", KindStock, "EUR", "100"},
		{"EURUSD=X", "EURUSD=X Test Corp", KindFX, "USD", "1.25"},
		{"EURGBP=X", "EURGBP=X Test Corp", KindFX, "GBP", "1.25"},
	}
	for _, c := range cases {
		t.Run(c.symbol, func(t *testing.T) {
			before := time.Now()
			got, err := NewFake().Chart(context.Background(), c.symbol, from)
			if err != nil {
				t.Fatal(err)
			}

			if got.Symbol != c.symbol || got.Name != c.name || got.Exchange != "NASDAQ" || got.Kind != c.kind || got.Currency != c.currency {
				t.Errorf("chart = %+v", got)
			}
			if len(got.Closes) != 4 {
				t.Fatalf("closes = %+v, want 4 days", got.Closes)
			}
			for i, dc := range got.Closes {
				if !dc.Date.Equal(from.AddDate(0, 0, i)) || dc.Close != c.close {
					t.Errorf("close %d = %+v", i, dc)
				}
			}
			if got.Latest != c.close || got.LatestAt.Before(before) {
				t.Errorf("Latest = %q at %v", got.Latest, got.LatestAt)
			}
		})
	}
}
