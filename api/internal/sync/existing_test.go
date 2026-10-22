package sync_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/sync"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
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

type existingEnv struct {
	handler http.Handler
	tokens  *auth.Tokens
}

func newExistingEnv(t *testing.T, pool *pgxpool.Pool) *existingEnv {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tokens := auth.NewTokens(key, "https://money.example.com")
	h := auth.NewHandlers(auth.Deps{Pool: pool, Tokens: tokens})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &existingEnv{handler: h.RequireUser(sync.NewExistingHandler(pool, logger)), tokens: tokens}
}

func (e *existingEnv) get(t *testing.T, userID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/import/existing", nil)
	if userID != "" {
		tok, err := e.tokens.IssueAccessToken(userID, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func insertUser(t *testing.T, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (id, email, password_hash, role)
		 VALUES (gen_random_uuid(), $1, 'x', 'user') RETURNING id::text`, email).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func insertAccount(t *testing.T, pool *pgxpool.Pool, userID, name string, sortOrder int, balance int64, archived bool) string {
	t.Helper()
	id := newID(t, pool)
	exec(t, pool,
		`INSERT INTO accounts (id, user_id, name, color, sort_order, opening_balance_minor, archived_at)
		 VALUES ($1, $2, $3, '#112233', $4, $5, CASE WHEN $6 THEN now() END)`,
		id, userID, name, sortOrder, balance, archived)
	return id
}

func insertCategory(t *testing.T, pool *pgxpool.Pool, userID, typ, name string, sortOrder int) string {
	t.Helper()
	id := newID(t, pool)
	exec(t, pool,
		`INSERT INTO categories (id, user_id, type, name, icon, color, sort_order)
		 VALUES ($1, $2, $3, $4, 'tag', '#112233', $5)`,
		id, userID, typ, name, sortOrder)
	return id
}

func decodeExisting(t *testing.T, rec *httptest.ResponseRecorder) existingBody {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body %s", rec.Code, rec.Body)
	}
	var body existingBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", rec.Body, err)
	}
	return body
}

func TestExistingReturnsOwnRecords(t *testing.T) {
	pool := testutil.StartPostgres(t)
	env := newExistingEnv(t, pool)
	a := insertUser(t, pool, "a@example.com")
	b := insertUser(t, pool, "b@example.com")

	exec(t, pool,
		`INSERT INTO user_settings (id, user_id, currency_code, time_period, week_start_day, month_start_day,
		   year_start_month, budget_mode, carry_over, hide_future, show_note, theme, summary_font, icon_style)
		 VALUES (gen_random_uuid(), $1, 'EUR', 'monthly', 1, 1, 1, false, true, false, true, 'system', 'mono', 'filled')`, a)
	closed := insertAccount(t, pool, a, "Closed", 1, 0, true)
	bank := insertAccount(t, pool, a, "Bank", 0, 1500, false)
	salary := insertCategory(t, pool, a, "income", "Salary", 1)
	food := insertCategory(t, pool, a, "expense", "Food", 0)
	insertAccount(t, pool, b, "Other", 0, 0, false)
	insertCategory(t, pool, b, "expense", "Other", 0)

	body := decodeExisting(t, env.get(t, a))

	if body.CurrencyCode != "EUR" {
		t.Errorf("currency_code = %q, want EUR", body.CurrencyCode)
	}
	wantAccounts := []existingAccount{
		{ID: bank, Name: "Bank", SortOrder: 0, OpeningBalanceMinor: 1500},
		{ID: closed, Name: "Closed", SortOrder: 1, Archived: true},
	}
	if len(body.Accounts) != len(wantAccounts) {
		t.Fatalf("accounts = %+v, want %+v", body.Accounts, wantAccounts)
	}
	for i, want := range wantAccounts {
		if body.Accounts[i] != want {
			t.Errorf("accounts[%d] = %+v, want %+v", i, body.Accounts[i], want)
		}
	}
	wantCategories := []existingCategory{
		{ID: food, Name: "Food", Type: "expense", SortOrder: 0},
		{ID: salary, Name: "Salary", Type: "income", SortOrder: 1},
	}
	if len(body.Categories) != len(wantCategories) {
		t.Fatalf("categories = %+v, want %+v", body.Categories, wantCategories)
	}
	for i, want := range wantCategories {
		if body.Categories[i] != want {
			t.Errorf("categories[%d] = %+v, want %+v", i, body.Categories[i], want)
		}
	}
}

func TestExistingUnauthorized(t *testing.T) {
	pool := testutil.StartPostgres(t)
	env := newExistingEnv(t, pool)
	wantError(t, env.get(t, ""), http.StatusUnauthorized, "unauthorized")
}

func TestExistingNoSettings(t *testing.T) {
	pool := testutil.StartPostgres(t)
	env := newExistingEnv(t, pool)
	u := insertUser(t, pool, "c@example.com")

	rec := env.get(t, u)
	body := decodeExisting(t, rec)
	if body.CurrencyCode != "" {
		t.Errorf("currency_code = %q, want empty", body.CurrencyCode)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"accounts", "categories"} {
		if string(raw[key]) != "[]" {
			t.Errorf("%s = %s, want []", key, raw[key])
		}
	}
}
