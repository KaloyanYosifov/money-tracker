package prices

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func serveFile(t *testing.T, name string) http.HandlerFunc {
	t.Helper()
	body, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}
}

func newTestYahoo(t *testing.T, h http.Handler) *Yahoo {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return NewYahoo(srv.URL, nil)
}

func utcDate(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func TestYahooSearch(t *testing.T) {
	var got *http.Request
	file := serveFile(t, "search.json")
	y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		file(w, r)
	}))

	matches, err := y.Search(context.Background(), "acme")
	if err != nil {
		t.Fatal(err)
	}

	if got.URL.Path != "/v1/finance/search" {
		t.Errorf("path = %q", got.URL.Path)
	}
	q := got.URL.Query()
	if q.Get("q") != "acme" || q.Get("quotesCount") != "10" || q.Get("newsCount") != "0" {
		t.Errorf("query = %q", got.URL.RawQuery)
	}
	if got.Header.Get("User-Agent") == "" || strings.HasPrefix(got.Header.Get("User-Agent"), "Go-http-client") {
		t.Errorf("User-Agent = %q, want a browser-like value", got.Header.Get("User-Agent"))
	}

	want := []Match{
		{Symbol: "ACME", Name: "Acme Corporation", Exchange: "NASDAQ", Kind: KindStock},
		{Symbol: "ACWX.DE", Name: "Acme World ETF", Exchange: "XETRA", Kind: KindETF},
		{Symbol: "ACM-USD", Name: "AcmeCoin USD", Exchange: "CCC", Kind: KindCrypto},
	}
	if len(matches) != len(want) {
		t.Fatalf("matches = %+v, want %+v", matches, want)
	}
	for i := range want {
		if matches[i] != want[i] {
			t.Errorf("match %d = %+v, want %+v", i, matches[i], want[i])
		}
	}
}

func TestYahooChart(t *testing.T) {
	var got *http.Request
	file := serveFile(t, "chart_usd.json")
	y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		file(w, r)
	}))
	from := utcDate(2025, 10, 28)

	before := time.Now().Unix()
	c, err := y.Chart(context.Background(), "ACME", from)
	if err != nil {
		t.Fatal(err)
	}

	if got.URL.Path != "/v8/finance/chart/ACME" {
		t.Errorf("path = %q", got.URL.Path)
	}
	q := got.URL.Query()
	if q.Get("interval") != "1d" || q.Get("period1") != strconv.FormatInt(from.Unix(), 10) {
		t.Errorf("query = %q", got.URL.RawQuery)
	}
	if p2, _ := strconv.ParseInt(q.Get("period2"), 10, 64); p2 < before {
		t.Errorf("period2 = %q, want now", q.Get("period2"))
	}
	if got.Header.Get("User-Agent") == "" {
		t.Error("no User-Agent")
	}

	if c.Symbol != "ACME" || c.Name != "Acme Corporation" || c.Exchange != "NasdaqGS" || c.Kind != KindStock || c.Currency != "USD" {
		t.Errorf("chart = %+v", c)
	}
	wantCloses := []DailyClose{
		{Date: utcDate(2025, 10, 28), Close: "120.5"},
		{Date: utcDate(2025, 10, 29), Close: "121.25"},
		{Date: utcDate(2025, 10, 30), Close: "0.00012345"},
	}
	assertCloses(t, c.Closes, wantCloses)
	if c.Latest != "123.45" {
		t.Errorf("Latest = %q", c.Latest)
	}
	if !c.LatestAt.Equal(time.Unix(1761940800, 0)) {
		t.Errorf("LatestAt = %v", c.LatestAt)
	}
}

func TestYahooChartGaps(t *testing.T) {
	y := newTestYahoo(t, serveFile(t, "chart_gaps.json"))

	c, err := y.Chart(context.Background(), "ACME", utcDate(2025, 10, 28))
	if err != nil {
		t.Fatal(err)
	}

	if c.Name != "Acme Corp" {
		t.Errorf("Name = %q, want the short name", c.Name)
	}
	assertCloses(t, c.Closes, []DailyClose{
		{Date: utcDate(2025, 10, 28), Close: "48"},
		{Date: utcDate(2025, 10, 30), Close: "49.5"},
	})
}

func TestYahooChartExchangeDates(t *testing.T) {
	body, err := os.ReadFile("testdata/chart_fx.json")
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		"time zone":         string(body),
		"unknown time zone": strings.Replace(string(body), "Europe/London", "Nowhere/Place", 1),
	} {
		t.Run(name, func(t *testing.T) {
			y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(data))
			}))

			c, err := y.Chart(context.Background(), "ZZZUSD=X", utcDate(2025, 10, 20))
			if err != nil {
				t.Fatal(err)
			}

			assertCloses(t, c.Closes, []DailyClose{
				{Date: utcDate(2025, 10, 22), Close: "1.16"},
				{Date: utcDate(2025, 10, 23), Close: "1.161"},
				{Date: utcDate(2025, 10, 27), Close: "1.162"},
			})
			if !c.LatestAt.Equal(time.Unix(1761175800, 0)) {
				t.Errorf("LatestAt = %v", c.LatestAt)
			}
			if y, m, d := c.LatestAt.Date(); y != 2025 || m != 10 || d != 23 {
				t.Errorf("LatestAt date = %d-%d-%d, want the exchange date 2025-10-23", y, m, d)
			}
		})
	}
}

func TestYahooChartWithoutLatest(t *testing.T) {
	body, err := os.ReadFile("testdata/chart_usd.json")
	if err != nil {
		t.Fatal(err)
	}
	data := strings.Replace(string(body), `"regularMarketTime": 1761940800,`, "", 1)
	data = strings.Replace(data, `"regularMarketPrice": 123.45,`, "", 1)
	y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(data))
	}))

	c, err := y.Chart(context.Background(), "ACME", utcDate(2025, 10, 28))
	if err != nil {
		t.Fatal(err)
	}

	if c.Latest != "" || !c.LatestAt.IsZero() {
		t.Errorf("Latest = %q at %v, want none", c.Latest, c.LatestAt)
	}
	if len(c.Closes) != 3 {
		t.Errorf("closes = %+v, want 3", c.Closes)
	}
}

func TestYahooChartPence(t *testing.T) {
	body, err := os.ReadFile("testdata/chart_gbp_pence.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, currency := range []string{"GBp", "GBX"} {
		t.Run(currency, func(t *testing.T) {
			data := strings.Replace(string(body), `"GBp"`, `"`+currency+`"`, 1)
			y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(data))
			}))

			c, err := y.Chart(context.Background(), "ACME.L", utcDate(2025, 10, 28))
			if err != nil {
				t.Fatal(err)
			}

			if c.Currency != "GBP" {
				t.Errorf("Currency = %q, want GBP", c.Currency)
			}
			assertCloses(t, c.Closes, []DailyClose{
				{Date: utcDate(2025, 10, 28), Close: "26.505"},
				{Date: utcDate(2025, 10, 29), Close: "0.055"},
			})
			if c.Latest != "26.85" {
				t.Errorf("Latest = %q, want 26.85", c.Latest)
			}
		})
	}
}

func TestYahooChartCurrencyKind(t *testing.T) {
	body, err := os.ReadFile("testdata/chart_usd.json")
	if err != nil {
		t.Fatal(err)
	}
	for typ, want := range map[string]string{"ETF": KindETF, "CRYPTOCURRENCY": KindCrypto, "CURRENCY": KindFX} {
		data := strings.Replace(string(body), `"EQUITY"`, `"`+typ+`"`, 1)
		y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(data))
		}))
		c, err := y.Chart(context.Background(), "ACME", utcDate(2025, 10, 28))
		if err != nil {
			t.Fatal(err)
		}
		if c.Kind != want {
			t.Errorf("instrumentType %s: Kind = %q, want %q", typ, c.Kind, want)
		}
	}
}

func TestYahooChartNotFound(t *testing.T) {
	notFound := `{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}`
	for name, status := range map[string]int{"status_404": http.StatusNotFound, "status_200": http.StatusOK} {
		t.Run(name, func(t *testing.T) {
			y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(notFound))
			}))

			_, err := y.Chart(context.Background(), "NOPE", utcDate(2025, 10, 28))
			if !errors.Is(err, ErrNotFound) {
				t.Errorf("err = %v, want ErrNotFound", err)
			}
		})
	}
}

func TestYahooChartContract(t *testing.T) {
	body, err := os.ReadFile("testdata/chart_usd.json")
	if err != nil {
		t.Fatal(err)
	}
	usd := string(body)
	noLatest := strings.Replace(strings.Replace(usd, `"regularMarketTime": 1761940800,`, "", 1), `"regularMarketPrice": 123.45,`, "", 1)
	for name, data := range map[string]string{
		"not json":            "<html>consent</html>",
		"no chart":            `{"finance":{}}`,
		"empty result":        `{"chart":{"result":[],"error":null}}`,
		"no symbol":           strings.Replace(usd, `"symbol": "ACME",`, "", 1),
		"no currency":         strings.Replace(usd, `"currency": "USD",`, "", 1),
		"price is a string":   strings.Replace(usd, `123.45`, `"123.45"`, 1),
		"fewer closes":        strings.Replace(usd, `[120.5, 121.25, 0.00012345]`, `[120.5, 121.25]`, 1),
		"no quote":            strings.Replace(usd, `"quote": [{"close": [120.5, 121.25, 0.00012345]}]`, `"quote": []`, 1),
		"no prices":           strings.Replace(noLatest, `[120.5, 121.25, 0.00012345]`, `[null, null, null]`, 1),
		"timestamp is a list": strings.Replace(usd, `[1761658200, 1761744600, 1761831000]`, `[["1761658200"]]`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(data))
			}))
			before := yahooRequests.Value("chart", resultContractBroken)

			_, err := y.Chart(context.Background(), "ACME", utcDate(2025, 10, 28))
			if !errors.Is(err, ErrContract) {
				t.Fatalf("err = %v, want ErrContract", err)
			}
			if got := yahooRequests.Value("chart", resultContractBroken) - before; got != 1 {
				t.Errorf("contract_broken count went up by %d, want 1", got)
			}
		})
	}
}

func TestYahooSearchContract(t *testing.T) {
	for name, data := range map[string]string{
		"not json":  "<html>consent</html>",
		"no quotes": `{"count":0}`,
	} {
		t.Run(name, func(t *testing.T) {
			y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(data))
			}))
			before := yahooRequests.Value("search", resultContractBroken)

			_, err := y.Search(context.Background(), "acme")
			if !errors.Is(err, ErrContract) {
				t.Fatalf("err = %v, want ErrContract", err)
			}
			if got := yahooRequests.Value("search", resultContractBroken) - before; got != 1 {
				t.Errorf("contract_broken count went up by %d, want 1", got)
			}
		})
	}

	for name, tc := range map[string]struct {
		data   string
		want   []Match
		result string
	}{
		"no matches": {`{"quotes":[]}`, nil, resultOK},
		"a quote without fields": {
			`{"quotes":[{"quoteType":"EQUITY"},{"symbol":"ACME"},{"symbol":"ACME","quoteType":"EQUITY","shortname":"Acme","exchDisp":"NASDAQ"}]}`,
			[]Match{{Symbol: "ACME", Name: "Acme", Exchange: "NASDAQ", Kind: KindStock}},
			resultContractBroken,
		},
	} {
		t.Run(name, func(t *testing.T) {
			y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(tc.data))
			}))
			before := yahooRequests.Value("search", tc.result)

			matches, err := y.Search(context.Background(), "acme")
			if err != nil {
				t.Fatal(err)
			}
			if len(matches) != len(tc.want) {
				t.Fatalf("matches = %+v, want %+v", matches, tc.want)
			}
			for i := range tc.want {
				if matches[i] != tc.want[i] {
					t.Errorf("match %d = %+v, want %+v", i, matches[i], tc.want[i])
				}
			}
			if got := yahooRequests.Value("search", tc.result) - before; got != 1 {
				t.Errorf("%s count went up by %d, want 1", tc.result, got)
			}
		})
	}
}

func TestYahooChartOnlyLatest(t *testing.T) {
	body, err := os.ReadFile("testdata/chart_usd.json")
	if err != nil {
		t.Fatal(err)
	}
	data := strings.Replace(string(body), `"timestamp": [1761658200, 1761744600, 1761831000],`, "", 1)
	data = strings.Replace(data, `"quote": [{"close": [120.5, 121.25, 0.00012345]}]`, `"quote": [{}]`, 1)
	y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(data))
	}))

	c, err := y.Chart(context.Background(), "ACME", utcDate(2025, 11, 1))
	if err != nil {
		t.Fatal(err)
	}

	if len(c.Closes) != 0 || c.Latest != "123.45" {
		t.Errorf("closes = %+v, latest = %q, want no closes and the latest price 123.45", c.Closes, c.Latest)
	}
}

func TestYahooRateLimited(t *testing.T) {
	y := newTestYahoo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
	}))

	if _, err := y.Chart(context.Background(), "ACME", utcDate(2025, 10, 28)); !errors.Is(err, ErrRateLimited) {
		t.Errorf("Chart err = %v, want ErrRateLimited", err)
	}
	if _, err := y.Search(context.Background(), "acme"); !errors.Is(err, ErrRateLimited) {
		t.Errorf("Search err = %v, want ErrRateLimited", err)
	}
}

func TestYahooTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-time.After(2 * time.Second):
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	y := NewYahoo(srv.URL, &http.Client{Timeout: 50 * time.Millisecond})

	_, err := y.Chart(context.Background(), "ACME", utcDate(2025, 10, 28))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want it to wrap context.DeadlineExceeded", err)
	}
}

func assertCloses(t *testing.T, got, want []DailyClose) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("closes = %+v, want %+v", got, want)
	}
	for i := range want {
		if !got[i].Date.Equal(want[i].Date) || got[i].Date.Location() != time.UTC || got[i].Close != want[i].Close {
			t.Errorf("close %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}
