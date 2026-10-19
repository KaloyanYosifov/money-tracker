package sync_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/schema"
	"github.com/KaloyanYosifov/money-tracker/api/internal/sync"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

// uploadEnv is the upload route behind RequireUser, as httpserver mounts it.
type uploadEnv struct {
	handler http.Handler
	tokens  *auth.Tokens
}

func newUploadEnv(t *testing.T, pool *pgxpool.Pool) *uploadEnv {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tokens := auth.NewTokens(key, "https://money.example.com")
	h := auth.NewHandlers(auth.Deps{Pool: pool, Tokens: tokens})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &uploadEnv{
		handler: h.RequireUser(sync.NewUploadHandler(pool, logger)),
		tokens:  tokens,
	}
}

func (e *uploadEnv) post(t *testing.T, userID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/sync/upload", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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

func txJSON(f fixture, amount int) string {
	return fmt.Sprintf(`{"user_id":%q,"type":"expense","amount_minor":%d,"currency_code":"EUR","date":"2026-10-19",
		"name":"Lunch","category_id":%q,"account_id":%q,"note":null,"source":"manual"}`,
		f.userID, amount, f.expenseCatID, f.accountID)
}

func TestUploadBatch(t *testing.T) {
	pool := testutil.StartPostgres(t)
	env := newUploadEnv(t, pool)
	a := seedUser(t, pool, "a@example.com")
	id0, id1, id2 := newID(t, pool), newID(t, pool), newID(t, pool)

	body := fmt.Sprintf(`{"schema_version":%d,"ops":[
		{"op":"PUT","table":"transactions","id":%q,"data":%s},
		{"op":"PUT","table":"transactions","id":%q,"data":{"user_id":%q,"type":"expense"}},
		{"op":"PUT","table":"transactions","id":%q,"data":%s}]}`,
		schema.SchemaVersion, id0, txJSON(a, 1250), id1, a.userID, id2, txJSON(a, 4200))
	rec := env.post(t, a.userID, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	var resp struct {
		Rejected []struct {
			Index   int    `json:"index"`
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"rejected"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Rejected) != 1 || resp.Rejected[0].Index != 1 ||
		resp.Rejected[0].Code != "invalid_record" || resp.Rejected[0].Message == "" {
		t.Fatalf("rejected = %+v, want one invalid_record at index 1", resp.Rejected)
	}

	ctx := context.Background()
	for id, want := range map[string]int64{id0: 1250, id2: 4200} {
		var got int64
		err := pool.QueryRow(ctx, `SELECT amount_minor FROM transactions WHERE id = $1`, id).Scan(&got)
		if err != nil {
			t.Fatalf("transaction %s: %v", id, err)
		}
		if got != want {
			t.Fatalf("amount_minor = %d, want %d", got, want)
		}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM transactions WHERE id = $1`, id1).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("rejected op 1 was written")
	}
}

func TestUploadOldSchema(t *testing.T) {
	env := newUploadEnv(t, nil)
	body := fmt.Sprintf(`{"schema_version":%d,"ops":[{"op":"DELETE","table":"accounts","id":"0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a11"}]}`,
		schema.MinSupportedSchemaVersion-1)
	wantError(t, env.post(t, "0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a10", body), http.StatusUpgradeRequired, "upgrade_required")
}

func TestUploadMalformed(t *testing.T) {
	env := newUploadEnv(t, nil)
	user := "0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a10"
	for name, body := range map[string]string{
		"not_json":   `{"schema_version":`,
		"no_ops":     fmt.Sprintf(`{"schema_version":%d,"ops":[]}`, schema.SchemaVersion),
		"bad_op":     fmt.Sprintf(`{"schema_version":%d,"ops":[{"op":"MERGE","table":"accounts","id":"0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a11"}]}`, schema.SchemaVersion),
		"bad_table":  fmt.Sprintf(`{"schema_version":%d,"ops":[{"op":"DELETE","table":"users","id":"0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a11"}]}`, schema.SchemaVersion),
		"no_version": `{"ops":[{"op":"DELETE","table":"accounts","id":"0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a11"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			wantError(t, env.post(t, user, body), http.StatusBadRequest, "invalid_request")
		})
	}
}

func TestUploadUnauthorized(t *testing.T) {
	env := newUploadEnv(t, nil)
	body := fmt.Sprintf(`{"schema_version":%d,"ops":[{"op":"DELETE","table":"accounts","id":"0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a11"}]}`, schema.SchemaVersion)
	wantError(t, env.post(t, "", body), http.StatusUnauthorized, "unauthorized")
}

func TestUploadDatabaseDown(t *testing.T) {
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig("postgres://nobody@127.0.0.1:1/none?sslmode=disable&connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	env := newUploadEnv(t, pool)
	body := fmt.Sprintf(`{"schema_version":%d,"ops":[{"op":"DELETE","table":"accounts","id":"0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a11"}]}`, schema.SchemaVersion)
	wantError(t, env.post(t, "0f0e1c39-6a43-4c39-9d5b-5f4f1f0a2a10", body), http.StatusServiceUnavailable, "unavailable")
}
