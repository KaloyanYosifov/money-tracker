package sync

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
)

type existingAccount struct {
	ID                  string `json:"id"`
	Name                string `json:"name"`
	SortOrder           int    `json:"sort_order"`
	OpeningBalanceMinor int64  `json:"opening_balance_minor"`
	Archived            bool   `json:"archived"`
}

type existingCategory struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	SortOrder int    `json:"sort_order"`
	Archived  bool   `json:"archived"`
}

type existingBody struct {
	CurrencyCode string             `json:"currency_code"`
	Accounts     []existingAccount  `json:"accounts"`
	Categories   []existingCategory `json:"categories"`
}

// NewExistingHandler serves GET /api/import/existing: the currency, accounts
// and categories of the user, so that an import can match its records to
// them. Wrap it in auth.Handlers.RequireUser.
func NewExistingHandler(pool *pgxpool.Pool, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := auth.UserID(r.Context())
		if userID == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		body, err := readExisting(r.Context(), pool, userID)
		if err != nil {
			logger.Error("import existing", "user_id", userID, "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeJSON(w, http.StatusOK, body)
	})
}

func readExisting(ctx context.Context, pool *pgxpool.Pool, userID string) (existingBody, error) {
	body := existingBody{Accounts: []existingAccount{}, Categories: []existingCategory{}}

	err := pool.QueryRow(ctx,
		`SELECT currency_code FROM user_settings WHERE user_id = $1 LIMIT 1`, userID).Scan(&body.CurrencyCode)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return body, err
	}

	rows, err := pool.Query(ctx,
		`SELECT id::text, name, sort_order, opening_balance_minor, archived_at IS NOT NULL
		 FROM accounts WHERE user_id = $1 ORDER BY sort_order, name`, userID)
	if err != nil {
		return body, err
	}
	accounts, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (existingAccount, error) {
		var a existingAccount
		err := row.Scan(&a.ID, &a.Name, &a.SortOrder, &a.OpeningBalanceMinor, &a.Archived)
		return a, err
	})
	if err != nil {
		return body, err
	}
	body.Accounts = append(body.Accounts, accounts...)

	rows, err = pool.Query(ctx,
		`SELECT id::text, name, type, sort_order, archived_at IS NOT NULL
		 FROM categories WHERE user_id = $1 ORDER BY sort_order, name`, userID)
	if err != nil {
		return body, err
	}
	categories, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (existingCategory, error) {
		var c existingCategory
		err := row.Scan(&c.ID, &c.Name, &c.Type, &c.SortOrder, &c.Archived)
		return c, err
	})
	if err != nil {
		return body, err
	}
	body.Categories = append(body.Categories, categories...)
	return body, nil
}
