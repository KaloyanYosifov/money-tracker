package prices

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
)

var symbolPattern = regexp.MustCompile(`^[A-Za-z0-9.^=-]{1,20}$`)

type matchJSON struct {
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Exchange string `json:"exchange"`
	Kind     string `json:"kind"`
}

type instrumentJSON struct {
	ID            string `json:"id"`
	Symbol        string `json:"symbol"`
	Name          string `json:"name"`
	Exchange      string `json:"exchange"`
	Kind          string `json:"kind"`
	QuoteCurrency string `json:"quote_currency"`
}

// NewSearchHandler serves GET /api/instruments/search?q=. Wrap it in
// auth.Handlers.RequireUser.
func NewSearchHandler(src PriceSource, limiter *auth.IPLimiter, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := auth.UserID(r.Context())
		if userID == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if !limiter.Allow("search:"+userID, time.Now()) {
			writeError(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if n := utf8.RuneCountInString(q); n < 2 || n > 50 {
			writeError(w, http.StatusBadRequest, "invalid_query")
			return
		}
		matches, err := src.Search(r.Context(), q)
		if err != nil {
			logger.Warn("instrument search", "user_id", userID, "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		results := make([]matchJSON, 0, len(matches))
		for _, m := range matches {
			results = append(results, matchJSON(m))
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": results})
	})
}

// NewAddHandler serves POST /api/instruments with the body {"symbol": "..."}.
// It links the instrument to the user, and creates it from a chart call if
// it does not exist. The worker fetches the prices later. Wrap it in
// auth.Handlers.RequireUser.
func NewAddHandler(pool *pgxpool.Pool, src PriceSource, limiter *auth.IPLimiter, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := auth.UserID(r.Context())
		if userID == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if !limiter.Allow("add:"+userID, time.Now()) {
			writeError(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		var body struct {
			Symbol string `json:"symbol"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		symbol := strings.ToUpper(strings.TrimSpace(body.Symbol))
		if !symbolPattern.MatchString(symbol) || strings.HasSuffix(symbol, "=X") {
			writeError(w, http.StatusBadRequest, "invalid_symbol")
			return
		}

		ctx := r.Context()
		chart, kind, err := knownInstrument(ctx, pool, symbol)
		if errors.Is(err, pgx.ErrNoRows) {
			chart, err = src.Chart(ctx, symbol, time.Now().AddDate(0, 0, -historyDays))
			kind = chart.Kind
			if chart.Symbol == "" {
				chart.Symbol = symbol
			}
		}
		switch {
		case errors.Is(err, ErrNotFound):
			writeError(w, http.StatusNotFound, "not_found")
			return
		case err != nil:
			logger.Warn("add instrument", "user_id", userID, "symbol", symbol, "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		case kind != KindStock && kind != KindETF && kind != KindCrypto:
			writeError(w, http.StatusBadRequest, "invalid_symbol")
			return
		}

		inst, err := LinkInstrument(ctx, pool, userID, chart, kind)
		if err != nil {
			logger.Error("add instrument", "user_id", userID, "symbol", symbol, "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeJSON(w, http.StatusOK, instrumentJSON(inst))
	})
}

func knownInstrument(ctx context.Context, db DB, symbol string) (Chart, string, error) {
	var c Chart
	var kind string
	err := db.QueryRow(ctx,
		`SELECT symbol, name, exchange, kind, quote_currency FROM instruments WHERE symbol = $1`, symbol).
		Scan(&c.Symbol, &c.Name, &c.Exchange, &kind, &c.Currency)
	return c, kind, err
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
