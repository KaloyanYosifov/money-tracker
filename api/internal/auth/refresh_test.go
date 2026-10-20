package auth_test

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

func newRefreshStore(t *testing.T) (*auth.RefreshStore, *pgxpool.Pool, *time.Time) {
	t.Helper()
	pool := testutil.StartPostgres(t)
	store := auth.NewRefreshStore(pool)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	store.Now = func() time.Time { return now }
	return store, pool, &now
}

func insertUser(t *testing.T, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (id, email, password_hash, role)
		 VALUES (gen_random_uuid(), $1, 'x', 'user') RETURNING id::text`, email).Scan(&id)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

func TestCreateAndRotate(t *testing.T) {
	ctx := context.Background()
	store, pool, _ := newRefreshStore(t)
	userID := insertUser(t, pool, "a@example.com")

	first, err := store.Create(ctx, userID, "iPhone")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(first.Token)
	if err != nil {
		t.Fatalf("token is not base64url: %v", err)
	}
	if len(raw) != 32 {
		t.Fatalf("token has %d bytes, want 32", len(raw))
	}
	if first.UserID != userID {
		t.Fatalf("UserID = %q, want %q", first.UserID, userID)
	}

	second, err := store.Rotate(ctx, first.Token)
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if second.Token == first.Token {
		t.Fatal("Rotate returned the same token")
	}
	if second.UserID != userID || second.SessionID != first.SessionID {
		t.Fatalf("Rotate changed user or family: %+v vs %+v", second, first)
	}

	var revoked, replaced bool
	err = pool.QueryRow(ctx,
		`SELECT revoked_at IS NOT NULL, replaced_by IS NOT NULL
		 FROM refresh_tokens WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
		first.Token).Scan(&revoked, &replaced)
	if err != nil {
		t.Fatalf("select old row by SHA-256 of the token: %v", err)
	}
	if !revoked || !replaced {
		t.Fatalf("old row: revoked=%v replaced=%v, want both true", revoked, replaced)
	}
}

func TestReuseRevokesFamily(t *testing.T) {
	ctx := context.Background()
	store, pool, _ := newRefreshStore(t)
	userID := insertUser(t, pool, "a@example.com")

	first, err := store.Create(ctx, userID, "iPhone")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	second, err := store.Rotate(ctx, first.Token)
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}

	if _, err := store.Rotate(ctx, first.Token); !errors.Is(err, auth.ErrTokenReused) {
		t.Fatalf("reuse: err = %v, want ErrTokenReused", err)
	}
	if _, err := store.Rotate(ctx, second.Token); !errors.Is(err, auth.ErrTokenRevoked) {
		t.Fatalf("newest token of a reused family: err = %v, want ErrTokenRevoked", err)
	}

	var active int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL`,
		first.SessionID).Scan(&active); err != nil {
		t.Fatalf("count: %v", err)
	}
	if active != 0 {
		t.Fatalf("%d active tokens left in the family, want 0", active)
	}
}

func TestExpiry(t *testing.T) {
	ctx := context.Background()
	store, pool, now := newRefreshStore(t)
	userID := insertUser(t, pool, "a@example.com")

	tok, err := store.Create(ctx, userID, "iPhone")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	*now = now.Add(89 * 24 * time.Hour)
	tok, err = store.Rotate(ctx, tok.Token)
	if err != nil {
		t.Fatalf("Rotate after 89 days: %v", err)
	}

	*now = now.Add(89 * 24 * time.Hour)
	tok, err = store.Rotate(ctx, tok.Token)
	if err != nil {
		t.Fatalf("Rotate 89 days after the last use: %v", err)
	}

	*now = now.Add(90*24*time.Hour + time.Second)
	if _, err := store.Rotate(ctx, tok.Token); !errors.Is(err, auth.ErrTokenExpired) {
		t.Fatalf("Rotate after 90 days: err = %v, want ErrTokenExpired", err)
	}
}

func TestRotateUnknownToken(t *testing.T) {
	store, _, _ := newRefreshStore(t)
	if _, err := store.Rotate(context.Background(), "bm90LWEtdG9rZW4"); !errors.Is(err, auth.ErrTokenInvalid) {
		t.Fatalf("err = %v, want ErrTokenInvalid", err)
	}
}

func TestRevokeSession(t *testing.T) {
	ctx := context.Background()
	store, pool, _ := newRefreshStore(t)
	alice := insertUser(t, pool, "a@example.com")
	bob := insertUser(t, pool, "b@example.com")

	phone, err := store.Create(ctx, alice, "iPhone")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	web, err := store.Create(ctx, alice, "Firefox")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := store.RevokeSession(ctx, bob, phone.SessionID); !errors.Is(err, auth.ErrSessionNotFound) {
		t.Fatalf("revoke as other user: err = %v, want ErrSessionNotFound", err)
	}
	if err := store.RevokeSession(ctx, alice, phone.SessionID); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	if _, err := store.Rotate(ctx, phone.Token); !errors.Is(err, auth.ErrTokenRevoked) {
		t.Fatalf("revoked session: err = %v, want ErrTokenRevoked", err)
	}
	if _, err := store.Rotate(ctx, web.Token); err != nil {
		t.Fatalf("other session stopped working: %v", err)
	}

	logout, err := store.Create(ctx, alice, "iPad")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.Revoke(ctx, logout.Token); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, err := store.Rotate(ctx, logout.Token); !errors.Is(err, auth.ErrTokenRevoked) {
		t.Fatalf("logged out token: err = %v, want ErrTokenRevoked", err)
	}
}

func TestRevokeAllForUser(t *testing.T) {
	ctx := context.Background()
	store, pool, _ := newRefreshStore(t)
	alice := insertUser(t, pool, "a@example.com")
	bob := insertUser(t, pool, "b@example.com")

	a1, _ := store.Create(ctx, alice, "iPhone")
	a2, _ := store.Create(ctx, alice, "Firefox")
	b1, err := store.Create(ctx, bob, "iPhone")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := store.RevokeAllForUser(ctx, alice); err != nil {
		t.Fatalf("RevokeAllForUser: %v", err)
	}
	for _, tok := range []auth.RefreshToken{a1, a2} {
		if _, err := store.Rotate(ctx, tok.Token); !errors.Is(err, auth.ErrTokenRevoked) {
			t.Fatalf("alice token: err = %v, want ErrTokenRevoked", err)
		}
	}
	if _, err := store.Rotate(ctx, b1.Token); err != nil {
		t.Fatalf("bob token stopped working: %v", err)
	}
}

func TestListSessions(t *testing.T) {
	ctx := context.Background()
	store, pool, now := newRefreshStore(t)
	alice := insertUser(t, pool, "a@example.com")
	bob := insertUser(t, pool, "b@example.com")
	created := *now

	phone, err := store.Create(ctx, alice, "iPhone")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	web, err := store.Create(ctx, alice, "Firefox")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := store.Create(ctx, bob, "Safari"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	gone, err := store.Create(ctx, alice, "Old iPad")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.Revoke(ctx, gone.Token); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	*now = now.Add(time.Hour)
	if _, err := store.Rotate(ctx, phone.Token); err != nil {
		t.Fatalf("Rotate: %v", err)
	}

	sessions, err := store.ListSessions(ctx, alice, phone.SessionID)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2: %+v", len(sessions), sessions)
	}
	byID := map[string]auth.Session{}
	for _, s := range sessions {
		byID[s.ID] = s
	}

	p, ok := byID[phone.SessionID]
	if !ok {
		t.Fatalf("phone session missing: %+v", sessions)
	}
	if p.DeviceName != "iPhone" || !p.Current {
		t.Fatalf("phone session = %+v", p)
	}
	if !p.CreatedAt.Equal(created) {
		t.Fatalf("phone CreatedAt = %v, want %v", p.CreatedAt, created)
	}
	if !p.LastUsedAt.Equal(*now) {
		t.Fatalf("phone LastUsedAt = %v, want %v", p.LastUsedAt, *now)
	}

	w, ok := byID[web.SessionID]
	if !ok {
		t.Fatalf("web session missing: %+v", sessions)
	}
	if w.DeviceName != "Firefox" || w.Current {
		t.Fatalf("web session = %+v", w)
	}
	if !w.LastUsedAt.Equal(created) {
		t.Fatalf("web LastUsedAt = %v, want %v", w.LastUsedAt, created)
	}
}
