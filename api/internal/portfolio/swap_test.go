package portfolio_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/portfolio"
)

type swapCase struct {
	Name string `json:"name"`
	Swap struct {
		ID           string `json:"id"`
		Date         string `json:"date"`
		FromQuantity string `json:"from_quantity"`
		ToQuantity   string `json:"to_quantity"`
		Fee          string `json:"fee"`
		Value        string `json:"value"`
		ToValue      string `json:"to_value"`
	} `json:"swap"`
	Expect struct {
		Sell vectorTrade `json:"sell"`
		Buy  vectorTrade `json:"buy"`
	} `json:"expect"`
}

func legOf(t portfolio.Trade) vectorTrade {
	return vectorTrade{ID: t.ID, Side: t.Side, Date: t.Date, Quantity: t.Quantity, Price: t.Price, Fee: t.Fee, Total: t.Total}
}

func TestSharedSwapVectors(t *testing.T) {
	data, err := os.ReadFile("../../../testdata/portfolio-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Swaps []swapCase `json:"swaps"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Swaps) == 0 {
		t.Fatal("no swap cases")
	}

	for _, c := range file.Swaps {
		t.Run(c.Name, func(t *testing.T) {
			sell, buy := portfolio.SwapLegs(portfolio.Swap{
				ID:           c.Swap.ID,
				Date:         c.Swap.Date,
				FromQuantity: c.Swap.FromQuantity,
				ToQuantity:   c.Swap.ToQuantity,
				Fee:          c.Swap.Fee,
				Value:        c.Swap.Value,
				ToValue:      c.Swap.ToValue,
			})
			if got := legOf(sell); got != c.Expect.Sell {
				t.Errorf("sell: got %+v, want %+v", got, c.Expect.Sell)
			}
			if got := legOf(buy); got != c.Expect.Buy {
				t.Errorf("buy: got %+v, want %+v", got, c.Expect.Buy)
			}
		})
	}
}
