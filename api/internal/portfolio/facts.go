package portfolio

import (
	"math/big"
	"sort"
	"strings"
	"time"
)

const (
	staleDays      = 7
	investedMonths = 6
)

type Instrument struct {
	Symbol        string
	Name          string
	Kind          string
	QuoteCurrency string
	Trades        []Trade
	Closes        []Close
	FXCloses      []Close
}

// HoldingFacts has amounts in the app currency. A nil amount or percent is unknown.
type HoldingFacts struct {
	Symbol        string
	Name          string
	Kind          string
	QuoteCurrency string
	ValueApp      *big.Int
	OpenProfitApp *big.Int
	Weight        *string
	OpenProfitPct *string
	LastTradeDate string
	LastCloseDate string
}

type Exposure struct {
	Currency string
	Share    string
}

// MonthAmount is the amount invested in one month. Amount is nil when a trade
// of the month has no FX rate.
type MonthAmount struct {
	Month  string
	Amount *big.Int
}

// Facts has amounts at the scale 10^12 in the app currency and percents from FormatPercent.
// FeesThisYear is nil when a fee of this year has no FX rate.
type Facts struct {
	Holdings         []HoldingFacts
	CurrencyExposure []Exposure
	FeesThisYear     *big.Int
	Invested         []MonthAmount
	Stale            []string
}

func month(date string) string {
	if len(date) < 7 {
		return date
	}
	return date[:7]
}

func percent(part, whole *big.Int) *string {
	if part == nil || whole == nil {
		return nil
	}
	if s, ok := FormatPercent(part, whole); ok {
		return &s
	}
	return nil
}

// BuildFacts uses the same rules as summarize in app/src/data/portfolio.ts:
// the value uses the last close, and the conversion uses the FX rate on today.
func BuildFacts(instruments []Instrument, appCurrency, today string) Facts {
	day, _ := time.Parse(time.DateOnly, today)
	staleBefore := day.AddDate(0, 0, -staleDays).Format(time.DateOnly)
	firstMonth := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, time.UTC)
	invested := make([]MonthAmount, investedMonths)
	monthIndex := map[string]int{}
	for i := range invested {
		m := firstMonth.AddDate(0, i-investedMonths+1, 0).Format("2006-01")
		invested[i] = MonthAmount{Month: m, Amount: new(big.Int)}
		monthIndex[m] = i
	}

	facts := Facts{FeesThisYear: new(big.Int), Invested: invested, Stale: []string{}}
	total := new(big.Int)
	exposure := map[string]*big.Int{}
	for _, in := range instruments {
		if in.Kind == "fx" {
			continue
		}
		closes := append([]Close(nil), in.Closes...)
		sort.SliceStable(closes, func(i, j int) bool { return closes[i].Date < closes[j].Date })
		lastCloseDate := ""
		if len(closes) > 0 {
			lastCloseDate = closes[len(closes)-1].Date
		}
		lastTradeDate := ""
		for _, t := range in.Trades {
			lastTradeDate = max(lastTradeDate, t.Date)
			rate := RateOn(in.FXCloses, t.Date)
			if fee := value(t.Fee); fee.Sign() != 0 && facts.FeesThisYear != nil && strings.HasPrefix(t.Date, day.Format("2006-")) {
				if fee := ToApp(fee, in.QuoteCurrency, appCurrency, rate); fee != nil {
					facts.FeesThisYear.Add(facts.FeesThisYear, fee)
				} else {
					facts.FeesThisYear = nil
				}
			}
			if i, ok := monthIndex[month(t.Date)]; ok && invested[i].Amount != nil {
				amount := amountOf(t, value(t.Quantity))
				if t.Side == "buy" {
					amount.Add(amount, value(t.Fee))
				} else {
					amount.Sub(amount, value(t.Fee)).Neg(amount)
				}
				if amount := ToApp(amount, in.QuoteCurrency, appCurrency, rate); amount != nil {
					invested[i].Amount.Add(invested[i].Amount, amount)
				} else {
					invested[i].Amount = nil
				}
			}
		}

		h := HoldingOf(in.Trades, "")
		if h.Quantity.Sign() <= 0 {
			continue
		}
		if lastCloseDate == "" || lastCloseDate < staleBefore {
			facts.Stale = append(facts.Stale, in.Symbol)
		}
		rate := RateOn(in.FXCloses, today)
		hf := HoldingFacts{
			Symbol:        in.Symbol,
			Name:          in.Name,
			Kind:          in.Kind,
			QuoteCurrency: in.QuoteCurrency,
			LastTradeDate: lastTradeDate,
			LastCloseDate: lastCloseDate,
		}
		if len(closes) > 0 {
			v := Mul(h.Quantity, value(closes[len(closes)-1].Close))
			openProfit := new(big.Int).Sub(v, h.Cost)
			hf.ValueApp = ToApp(v, in.QuoteCurrency, appCurrency, rate)
			hf.OpenProfitApp = ToApp(openProfit, in.QuoteCurrency, appCurrency, rate)
			hf.OpenProfitPct = percent(openProfit, h.Cost)
		}
		if hf.ValueApp != nil {
			total.Add(total, hf.ValueApp)
			if exposure[in.QuoteCurrency] == nil {
				exposure[in.QuoteCurrency] = new(big.Int)
			}
			exposure[in.QuoteCurrency].Add(exposure[in.QuoteCurrency], hf.ValueApp)
		}
		facts.Holdings = append(facts.Holdings, hf)
	}

	for i := range facts.Holdings {
		facts.Holdings[i].Weight = percent(facts.Holdings[i].ValueApp, total)
	}
	sort.SliceStable(facts.Holdings, func(i, j int) bool {
		a, b := facts.Holdings[i].ValueApp, facts.Holdings[j].ValueApp
		if a == nil || b == nil {
			if (a == nil) != (b == nil) {
				return b == nil
			}
		} else if c := a.Cmp(b); c != 0 {
			return c > 0
		}
		return facts.Holdings[i].Symbol < facts.Holdings[j].Symbol
	})

	currencies := make([]string, 0, len(exposure))
	for c := range exposure {
		currencies = append(currencies, c)
	}
	sort.Slice(currencies, func(i, j int) bool {
		if c := exposure[currencies[i]].Cmp(exposure[currencies[j]]); c != 0 {
			return c > 0
		}
		return currencies[i] < currencies[j]
	})
	for _, c := range currencies {
		if share := percent(exposure[c], total); share != nil {
			facts.CurrencyExposure = append(facts.CurrencyExposure, Exposure{Currency: c, Share: *share})
		}
	}
	sort.Strings(facts.Stale)
	return facts
}
