package portfolio

import (
	"math/big"
	"sort"
)

type Trade struct {
	ID       string
	Side     string
	Date     string
	Quantity string
	Price    string
	Fee      string
	// Total is the amount before the fee, used in place of Quantity × Price. Empty means not set.
	Total string
}

type Close struct {
	Date  string
	Close string
}

type Realized struct {
	Date   string
	Amount *big.Int
}

// Holding has fixed values in the quote currency of the instrument.
type Holding struct {
	Quantity *big.Int
	Cost     *big.Int
	Fees     *big.Int
	Realized []Realized
}

// amountOf is the trade amount before the fee.
func amountOf(t Trade, quantity *big.Int) *big.Int {
	if t.Total != "" {
		return value(t.Total)
	}
	return Mul(quantity, value(t.Price))
}

func value(s string) *big.Int {
	if v, ok := ParseFixed(s); ok {
		return v
	}
	return new(big.Int)
}

// SortTrades returns a copy sorted by date, then buys before sells on the same date, then id.
func SortTrades(trades []Trade) []Trade {
	sorted := append([]Trade(nil), trades...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		if a.Side != b.Side {
			return a.Side == "buy"
		}
		return a.ID < b.ID
	})
	return sorted
}

// HoldingOf computes the FIFO lots of the trades on or before onDate (all trades if onDate is empty).
func HoldingOf(trades []Trade, onDate string) Holding {
	type lot struct{ quantity, cost *big.Int }
	var lots []*lot
	realized := []Realized{}
	fees := new(big.Int)
	for _, t := range SortTrades(trades) {
		if onDate != "" && t.Date > onDate {
			break
		}
		quantity := value(t.Quantity)
		fee := value(t.Fee)
		fees.Add(fees, fee)
		if t.Side == "buy" {
			lots = append(lots, &lot{quantity, new(big.Int).Add(amountOf(t, quantity), fee)})
			continue
		}
		rest := new(big.Int).Set(quantity)
		cost := new(big.Int)
		for rest.Sign() > 0 && len(lots) > 0 {
			l := lots[0]
			if l.quantity.Cmp(rest) <= 0 {
				rest.Sub(rest, l.quantity)
				cost.Add(cost, l.cost)
				lots = lots[1:]
			} else {
				part := new(big.Int).Quo(new(big.Int).Mul(l.cost, rest), l.quantity)
				l.quantity = new(big.Int).Sub(l.quantity, rest)
				l.cost = new(big.Int).Sub(l.cost, part)
				cost.Add(cost, part)
				rest.SetInt64(0)
			}
		}
		amount := amountOf(t, quantity)
		amount.Sub(amount, fee).Sub(amount, cost)
		realized = append(realized, Realized{Date: t.Date, Amount: amount})
	}
	h := Holding{Quantity: new(big.Int), Cost: new(big.Int), Fees: fees, Realized: realized}
	for _, l := range lots {
		h.Quantity.Add(h.Quantity, l.quantity)
		h.Cost.Add(h.Cost, l.cost)
	}
	return h
}

// RateOn returns the close on date, else the latest earlier close, else nil.
func RateOn(fxCloses []Close, date string) *big.Int {
	sorted := append([]Close(nil), fxCloses...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Date < sorted[j].Date })
	i := sort.Search(len(sorted), func(i int) bool { return sorted[i].Date > date })
	if i == 0 {
		return nil
	}
	return value(sorted[i-1].Close)
}

// ToApp converts a quote amount to the app currency. The rate is quote units for one app unit.
func ToApp(amount *big.Int, quote, app string, rate *big.Int) *big.Int {
	if quote == app {
		return amount
	}
	if rate == nil || rate.Sign() == 0 {
		return nil
	}
	return Div(amount, rate)
}
