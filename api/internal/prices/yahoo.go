package prices

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	// Exchange time zones must load in images without a zoneinfo database.
	_ "time/tzdata"

	"github.com/KaloyanYosifov/money-tracker/api/internal/metrics"
)

// Yahoo refuses requests with the default Go User-Agent.
const yahooUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

const maxBodyBytes = 5 << 20

// ErrContract means that a Yahoo answer does not have the fields and types
// that the app reads. The answer is not used.
var ErrContract = errors.New("prices: yahoo response breaks the contract")

const (
	resultOK             = "ok"
	resultContractBroken = "contract_broken"
	resultRateLimited    = "rate_limited"
	resultNotFound       = "not_found"
	resultError          = "error"
)

var yahooRequests = metrics.NewCounterVec("mtapi_yahoo_requests_total",
	"Requests to Yahoo Finance by endpoint and result.", "endpoint", "result")

func init() {
	for _, endpoint := range []string{"chart", "search"} {
		for _, result := range []string{resultOK, resultContractBroken, resultRateLimited, resultNotFound, resultError} {
			yahooRequests.Init(endpoint, result)
		}
	}
}

// observe counts a request. A contract break is logged as an error.
func observe(endpoint string, err error) {
	result := resultError
	switch {
	case err == nil:
		result = resultOK
	case errors.Is(err, ErrContract):
		result = resultContractBroken
		slog.Error("yahoo response breaks the contract", "endpoint", endpoint, "err", err)
	case errors.Is(err, ErrRateLimited):
		result = resultRateLimited
	case errors.Is(err, ErrNotFound):
		result = resultNotFound
	}
	yahooRequests.Inc(endpoint, result)
}

var yahooKinds = map[string]string{
	"EQUITY":         KindStock,
	"ETF":            KindETF,
	"CRYPTOCURRENCY": KindCrypto,
	"CURRENCY":       KindFX,
}

// Yahoo is a PriceSource for the Yahoo Finance API.
type Yahoo struct {
	baseURL string
	http    *http.Client
}

// NewYahoo returns a Yahoo source. A nil client gets a client with a 10
// second timeout.
func NewYahoo(baseURL string, client *http.Client) *Yahoo {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &Yahoo{baseURL: strings.TrimRight(baseURL, "/"), http: client}
}

type yahooSearchResponse struct {
	Quotes []struct {
		Symbol    string `json:"symbol"`
		QuoteType string `json:"quoteType"`
		LongName  string `json:"longname"`
		ShortName string `json:"shortname"`
		ExchDisp  string `json:"exchDisp"`
	} `json:"quotes"`
}

// Search returns the stocks, ETFs and coins that match query. Other quote
// types are dropped. A quote without a symbol or a quote type is dropped and
// counted as a contract break.
func (y *Yahoo) Search(ctx context.Context, query string) ([]Match, error) {
	q := url.Values{"q": {query}, "quotesCount": {"10"}, "newsCount": {"0"}}
	var resp yahooSearchResponse
	err := y.get(ctx, "/v1/finance/search?"+q.Encode(), &resp)
	if err == nil && resp.Quotes == nil {
		err = fmt.Errorf("%w: no quotes array", ErrContract)
	}
	if err != nil {
		observe("search", err)
		return nil, fmt.Errorf("yahoo search %q: %w", query, err)
	}
	matches := []Match{}
	broken := 0
	for _, quote := range resp.Quotes {
		if quote.Symbol == "" || quote.QuoteType == "" {
			broken++
			continue
		}
		kind, ok := yahooKinds[quote.QuoteType]
		if !ok || kind == KindFX {
			continue
		}
		matches = append(matches, Match{
			Symbol:   quote.Symbol,
			Name:     firstNonEmpty(quote.LongName, quote.ShortName),
			Exchange: quote.ExchDisp,
			Kind:     kind,
		})
	}
	if broken > 0 {
		err = fmt.Errorf("%w: %d quotes have no symbol or quoteType", ErrContract, broken)
	}
	observe("search", err)
	return matches, nil
}

type yahooChartResponse struct {
	Chart struct {
		Result []struct {
			Meta struct {
				Currency           string  `json:"currency"`
				Symbol             string  `json:"symbol"`
				FullExchangeName   string  `json:"fullExchangeName"`
				InstrumentType     string  `json:"instrumentType"`
				GMTOffset          int     `json:"gmtoffset"`
				TimezoneName       string  `json:"exchangeTimezoneName"`
				RegularMarketTime  int64   `json:"regularMarketTime"`
				RegularMarketPrice float64 `json:"regularMarketPrice"`
				LongName           string  `json:"longName"`
				ShortName          string  `json:"shortName"`
			} `json:"meta"`
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Close []*float64 `json:"close"`
				} `json:"quote"`
			} `json:"indicators"`
		} `json:"result"`
		Error *yahooError `json:"error"`
	} `json:"chart"`
}

type yahooError struct {
	Code        string `json:"code"`
	Description string `json:"description"`
}

// Chart returns the daily closes of symbol from the date of from to now. Kind
// is empty if Yahoo gives an instrument type that the app does not support.
// Prices in pence (GBp, GBX) are converted to GBP.
func (y *Yahoo) Chart(ctx context.Context, symbol string, from time.Time) (Chart, error) {
	c, err := y.chart(ctx, symbol, from)
	observe("chart", err)
	return c, err
}

// chart is Chart without the metrics. The contract is a result or an error,
// meta.symbol and meta.currency, one close for each timestamp, and at least
// one price.
func (y *Yahoo) chart(ctx context.Context, symbol string, from time.Time) (Chart, error) {
	q := url.Values{
		"interval": {"1d"},
		"period1":  {strconv.FormatInt(from.Unix(), 10)},
		"period2":  {strconv.FormatInt(time.Now().Unix(), 10)},
	}
	var resp yahooChartResponse
	if err := y.get(ctx, "/v8/finance/chart/"+url.PathEscape(symbol)+"?"+q.Encode(), &resp); err != nil {
		return Chart{}, fmt.Errorf("yahoo chart %s: %w", symbol, err)
	}
	if e := resp.Chart.Error; e != nil {
		if e.Code == "Not Found" {
			return Chart{}, fmt.Errorf("yahoo chart %s: %w", symbol, ErrNotFound)
		}
		return Chart{}, fmt.Errorf("yahoo chart %s: %s: %s", symbol, e.Code, e.Description)
	}
	if len(resp.Chart.Result) == 0 {
		return Chart{}, fmt.Errorf("yahoo chart %s: %w: no result and no error", symbol, ErrContract)
	}
	r := resp.Chart.Result[0]
	if r.Meta.Symbol == "" || r.Meta.Currency == "" {
		return Chart{}, fmt.Errorf("yahoo chart %s: %w: no meta.symbol or meta.currency", symbol, ErrContract)
	}

	currency := r.Meta.Currency
	format := FormatDecimal
	if currency == "GBp" || currency == "GBX" {
		currency = "GBP"
		format = func(v float64) (string, error) {
			s, err := formatDecimal(v, maxFracDigits-2)
			if err != nil {
				return "", err
			}
			return ShiftDecimal(s, 2), nil
		}
	}

	// Daily bars start at the session start in exchange time, so the date of a
	// bar is its date in the exchange time zone.
	loc, err := time.LoadLocation(r.Meta.TimezoneName)
	if err != nil || r.Meta.TimezoneName == "" {
		loc = time.FixedZone("", r.Meta.GMTOffset)
	}

	c := Chart{
		Symbol:   r.Meta.Symbol,
		Name:     firstNonEmpty(r.Meta.LongName, r.Meta.ShortName),
		Exchange: r.Meta.FullExchangeName,
		Kind:     yahooKinds[r.Meta.InstrumentType],
		Currency: currency,
	}
	if r.Meta.RegularMarketTime > 0 && r.Meta.RegularMarketPrice > 0 {
		latest, err := format(r.Meta.RegularMarketPrice)
		if err != nil {
			return Chart{}, fmt.Errorf("yahoo chart %s: latest price: %w", symbol, err)
		}
		c.Latest = latest
		c.LatestAt = time.Unix(r.Meta.RegularMarketTime, 0).In(loc)
	}

	var closes []*float64
	if len(r.Indicators.Quote) > 0 {
		closes = r.Indicators.Quote[0].Close
	}
	if len(closes) != len(r.Timestamp) {
		return Chart{}, fmt.Errorf("yahoo chart %s: %w: %d timestamps and %d closes",
			symbol, ErrContract, len(r.Timestamp), len(closes))
	}
	for i, ts := range r.Timestamp {
		if closes[i] == nil {
			continue
		}
		s, err := format(*closes[i])
		if err != nil {
			return Chart{}, fmt.Errorf("yahoo chart %s: close: %w", symbol, err)
		}
		y, m, d := time.Unix(ts, 0).In(loc).Date()
		date := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
		c.Closes = append(c.Closes, DailyClose{Date: date, Close: s})
	}
	if len(c.Closes) == 0 && c.Latest == "" {
		return Chart{}, fmt.Errorf("yahoo chart %s: %w: no closes and no latest price", symbol, ErrContract)
	}
	return c, nil
}

func (y *Yahoo) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, y.baseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", yahooUserAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := y.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	switch {
	case resp.StatusCode == http.StatusTooManyRequests:
		return ErrRateLimited
	case resp.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("%w: decode response: %v", ErrContract, err)
	}
	return nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
