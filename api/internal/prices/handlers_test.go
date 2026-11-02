package prices

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

type stubSource struct {
	matches   []Match
	searchErr error
	chart     Chart
	chartErr  error
	charts    int
}

func (s *stubSource) Search(context.Context, string) ([]Match, error) {
	return s.matches, s.searchErr
}

func (s *stubSource) Chart(_ context.Context, symbol string, _ time.Time) (Chart, error) {
	s.charts++
	if s.chartErr != nil {
		return Chart{}, s.chartErr
	}
	c := s.chart
	c.Symbol = symbol
	return c, nil
}

type handlerEnv struct {
	search http.Handler
	add    http.Handler
	tokens *auth.Tokens
}

func newHandlerEnv(t *testing.T, pool *pgxpool.Pool, src PriceSource) *handlerEnv {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tokens := auth.NewTokens(key, "https://money.example.com")
	h := auth.NewHandlers(auth.Deps{Pool: pool, Tokens: tokens})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	limiter := auth.NewIPLimiter()
	return &handlerEnv{
		search: h.RequireUser(NewSearchHandler(src, limiter, logger)),
		add:    h.RequireUser(NewAddHandler(pool, src, limiter, logger)),
		tokens: tokens,
	}
}

func (e *handlerEnv) serve(t *testing.T, h http.Handler, req *http.Request, userID string) *httptest.ResponseRecorder {
	t.Helper()
	if userID != "" {
		tok, err := e.tokens.IssueAccessToken(userID, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func (e *handlerEnv) doSearch(t *testing.T, userID, q string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/instruments/search?q="+url.QueryEscape(q), nil)
	return e.serve(t, e.search, req, userID)
}

func (e *handlerEnv) doAdd(t *testing.T, userID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/instruments", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return e.serve(t, e.add, req, userID)
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d, body %s", rec.Code, status, rec.Body)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", rec.Body, err)
	}
	if body.Error != code {
		t.Fatalf("error = %q, want %q", body.Error, code)
	}
}

// The search handler does not use the database, so these tests need no
// Postgres. Tokens are checked without a user row.
const searchUser = "0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a10"

func TestSearchHandlerUnauthorized(t *testing.T) {
	env := newHandlerEnv(t, nil, &stubSource{})
	wantError(t, env.doSearch(t, "", "acme"), http.StatusUnauthorized, "unauthorized")
}

func TestSearchHandlerInvalidQuery(t *testing.T) {
	for name, q := range map[string]string{
		"empty":         "",
		"one character": " a ",
		"too long":      strings.Repeat("x", 51),
	} {
		t.Run(name, func(t *testing.T) {
			env := newHandlerEnv(t, nil, &stubSource{})
			wantError(t, env.doSearch(t, searchUser, q), http.StatusBadRequest, "invalid_query")
		})
	}
}

func TestSearchHandlerResults(t *testing.T) {
	src := &stubSource{matches: []Match{
		{Symbol: "ACME", Name: "Acme Widgets Inc.", Exchange: "NASDAQ", Kind: KindStock},
		{Symbol: "ACMW.DE", Name: "Acme World ETF", Exchange: "XETRA", Kind: KindETF},
	}}
	env := newHandlerEnv(t, nil, src)

	rec := env.doSearch(t, searchUser, "  acme ")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	want := `{"results":[{"symbol":"ACME","name":"Acme Widgets Inc.","exchange":"NASDAQ","kind":"stock"},` +
		`{"symbol":"ACMW.DE","name":"Acme World ETF","exchange":"XETRA","kind":"etf"}]}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Errorf("body = %s, want %s", got, want)
	}

	src.matches = nil
	rec = env.doSearch(t, searchUser, "zz")
	if got := strings.TrimSpace(rec.Body.String()); rec.Code != http.StatusOK || got != `{"results":[]}` {
		t.Errorf("no matches: status %d, body %s", rec.Code, got)
	}
}

func TestSearchHandlerRateLimit(t *testing.T) {
	env := newHandlerEnv(t, nil, &stubSource{})
	for n := 1; n <= 10; n++ {
		if rec := env.doSearch(t, searchUser, "acme"); rec.Code != http.StatusOK {
			t.Fatalf("call %d: status = %d, body %s", n, rec.Code, rec.Body)
		}
	}
	wantError(t, env.doSearch(t, searchUser, "acme"), http.StatusTooManyRequests, "rate_limited")

	other := "7b1d3f0e-2c4a-4e8b-9f6d-1a2b3c4d5e6f"
	if rec := env.doSearch(t, other, "acme"); rec.Code != http.StatusOK {
		t.Errorf("second user: status = %d, want 200", rec.Code)
	}
}

func TestSearchHandlerSourceError(t *testing.T) {
	for name, err := range map[string]error{
		"rate limited": ErrRateLimited,
		"other":        errors.New("connection reset"),
	} {
		t.Run(name, func(t *testing.T) {
			env := newHandlerEnv(t, nil, &stubSource{searchErr: err})
			wantError(t, env.doSearch(t, searchUser, "acme"), http.StatusServiceUnavailable, "unavailable")
		})
	}
}

type addBody struct {
	ID            string `json:"id"`
	Symbol        string `json:"symbol"`
	Name          string `json:"name"`
	Exchange      string `json:"exchange"`
	Kind          string `json:"kind"`
	QuoteCurrency string `json:"quote_currency"`
}

func decodeAdd(t *testing.T, rec *httptest.ResponseRecorder) addBody {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body %s", rec.Code, rec.Body)
	}
	var body addBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", rec.Body, err)
	}
	return body
}

func acmeChart() Chart {
	return Chart{Name: "Acme Widgets Inc.", Exchange: "NASDAQ", Kind: KindStock, Currency: "USD"}
}

func TestAddHandler(t *testing.T) {
	pool := testutil.StartPostgres(t)
	src := &stubSource{chart: acmeChart()}
	env := newHandlerEnv(t, pool, src)
	user := newUser(t, pool, "EUR")

	t.Run("unauthorized", func(t *testing.T) {
		wantError(t, env.doAdd(t, "", `{"symbol":"ACME"}`), http.StatusUnauthorized, "unauthorized")
	})

	t.Run("adds and links", func(t *testing.T) {
		got := decodeAdd(t, env.doAdd(t, user, `{"symbol":"ACME"}`))
		want := addBody{ID: got.ID, Symbol: "ACME", Name: "Acme Widgets Inc.", Exchange: "NASDAQ", Kind: KindStock, QuoteCurrency: "USD"}
		if got.ID == "" || got != want {
			t.Errorf("body = %+v, want %+v", got, want)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM user_instruments WHERE user_id = $1 AND instrument_id = $2`, user, got.ID); n != 1 {
			t.Errorf("link rows = %d, want 1", n)
		}
	})

	t.Run("same symbol two times", func(t *testing.T) {
		first := decodeAdd(t, env.doAdd(t, user, `{"symbol":"ACMX"}`))
		charts := src.charts
		second := decodeAdd(t, env.doAdd(t, user, `{"symbol":"ACMX"}`))
		if second.ID != first.ID {
			t.Errorf("second id = %s, want %s", second.ID, first.ID)
		}
		if src.charts != charts {
			t.Errorf("chart calls for a known instrument = %d, want 0", src.charts-charts)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM instruments WHERE symbol = 'ACMX'`); n != 1 {
			t.Errorf("instrument rows = %d, want 1", n)
		}
	})

	t.Run("known instrument links a second user", func(t *testing.T) {
		other := newUser(t, pool, "EUR")
		got := decodeAdd(t, env.doAdd(t, other, `{"symbol":"ACME"}`))
		if n := countRows(t, pool, `SELECT count(*) FROM user_instruments WHERE user_id = $1 AND instrument_id = $2`, other, got.ID); n != 1 {
			t.Errorf("link rows = %d, want 1", n)
		}
	})

	t.Run("invalid symbol", func(t *testing.T) {
		for _, body := range []string{
			`{"symbol":""}`,
			`{"symbol":"AC ME"}`,
			`{"symbol":"ACME;DROP"}`,
			`{"symbol":"` + strings.Repeat("A", 21) + `"}`,
			`{"symbol":"EURUSD=X"}`,
			`{"symbol":"eurgbp=x"}`,
		} {
			wantError(t, env.doAdd(t, user, body), http.StatusBadRequest, "invalid_symbol")
		}
	})

	t.Run("invalid body", func(t *testing.T) {
		wantError(t, env.doAdd(t, user, `not json`), http.StatusBadRequest, "invalid_request")
	})

	t.Run("not found", func(t *testing.T) {
		env := newHandlerEnv(t, pool, &stubSource{chartErr: ErrNotFound})
		wantError(t, env.doAdd(t, user, `{"symbol":"NOPE"}`), http.StatusNotFound, "not_found")
	})

	t.Run("source error", func(t *testing.T) {
		env := newHandlerEnv(t, pool, &stubSource{chartErr: ErrRateLimited})
		wantError(t, env.doAdd(t, user, `{"symbol":"BUSY"}`), http.StatusServiceUnavailable, "unavailable")
	})

	t.Run("kind not supported", func(t *testing.T) {
		for symbol, kind := range map[string]string{"FXLIKE": KindFX, "FUNDX": ""} {
			c := acmeChart()
			c.Kind = kind
			env := newHandlerEnv(t, pool, &stubSource{chart: c})
			wantError(t, env.doAdd(t, user, `{"symbol":"`+symbol+`"}`), http.StatusBadRequest, "invalid_symbol")
			if n := countRows(t, pool, `SELECT count(*) FROM instruments WHERE symbol = $1`, symbol); n != 0 {
				t.Errorf("%s: instrument rows = %d, want 0", symbol, n)
			}
		}
	})
}

func TestAddHandlerRateLimit(t *testing.T) {
	env := newHandlerEnv(t, nil, &stubSource{})
	for n := 1; n <= 10; n++ {
		wantError(t, env.doAdd(t, searchUser, `{"symbol":"NOT VALID"}`), http.StatusBadRequest, "invalid_symbol")
	}
	wantError(t, env.doAdd(t, searchUser, `{"symbol":"NOT VALID"}`), http.StatusTooManyRequests, "rate_limited")

	if rec := env.doSearch(t, searchUser, "acme"); rec.Code != http.StatusOK {
		t.Errorf("search after the add limit: status = %d, want 200", rec.Code)
	}
}
