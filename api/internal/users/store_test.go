package users_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

func newStore(t *testing.T) (*users.Store, *pgxpool.Pool, *time.Time) {
	t.Helper()
	pool := testutil.StartPostgres(t)
	store := users.NewStore(pool)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	store.Now = func() time.Time { return now }
	return store, pool, &now
}

func TestCreateInvite(t *testing.T) {
	ctx := context.Background()
	store, pool, now := newStore(t)

	token, err := store.CreateInvite(ctx, "Anna@Example.com", "EUR", "admin")
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		t.Fatalf("token is not base64url: %v", err)
	}
	if len(raw) != 32 {
		t.Fatalf("token has %d bytes, want 32", len(raw))
	}

	var (
		hash      []byte
		email     string
		currency  string
		role      string
		expiresAt time.Time
		count     int
	)
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM invites`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("invites has %d rows, want 1", count)
	}
	err = pool.QueryRow(ctx,
		`SELECT token_hash, email::text, currency_code, role, expires_at FROM invites`).
		Scan(&hash, &email, &currency, &role, &expiresAt)
	if err != nil {
		t.Fatalf("read invite: %v", err)
	}
	want := sha256.Sum256([]byte(token))
	if !bytes.Equal(hash, want[:]) {
		t.Fatal("token_hash is not the SHA-256 of the token")
	}
	if bytes.Contains(hash, []byte(token)) {
		t.Fatal("the plain token is stored")
	}
	if email != "Anna@Example.com" || currency != "EUR" || role != "admin" {
		t.Fatalf("invite = %q %q %q", email, currency, role)
	}
	if !expiresAt.Equal(now.Add(72 * time.Hour)) {
		t.Fatalf("expires_at = %v, want %v", expiresAt, now.Add(72*time.Hour))
	}

	inv, err := store.CheckInvite(ctx, token)
	if err != nil {
		t.Fatalf("CheckInvite: %v", err)
	}
	if inv.Email != "Anna@Example.com" || inv.CurrencyCode != "EUR" || inv.Role != "admin" {
		t.Fatalf("CheckInvite = %+v", inv)
	}
}

func TestCreateInviteRejectsBadInput(t *testing.T) {
	ctx := context.Background()
	store, _, _ := newStore(t)

	cases := []struct{ email, currency, role string }{
		{"", "EUR", "user"},
		{"a@example.com", "eur", "user"},
		{"a@example.com", "EURO", "user"},
		{"a@example.com", "EUR", "root"},
	}
	for _, c := range cases {
		if _, err := store.CreateInvite(ctx, c.email, c.currency, c.role); err == nil {
			t.Errorf("CreateInvite(%q, %q, %q) returned no error", c.email, c.currency, c.role)
		}
	}
}

func TestAcceptInviteRejectsExpiredOrUsed(t *testing.T) {
	ctx := context.Background()
	store, pool, now := newStore(t)

	if _, err := store.CheckInvite(ctx, "unknown"); !errors.Is(err, users.ErrInviteInvalid) {
		t.Fatalf("unknown token: err = %v, want ErrInviteInvalid", err)
	}

	token, err := store.CreateInvite(ctx, "a@example.com", "EUR", "user")
	if err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	inv, err := store.AcceptInvite(ctx, tx, token)
	if err != nil {
		t.Fatalf("AcceptInvite: %v", err)
	}
	if inv.Email != "a@example.com" {
		t.Fatalf("AcceptInvite email = %q", inv.Email)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := store.CheckInvite(ctx, token); !errors.Is(err, users.ErrInviteUsed) {
		t.Fatalf("CheckInvite after use: err = %v, want ErrInviteUsed", err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcceptInvite(ctx, tx, token); !errors.Is(err, users.ErrInviteUsed) {
		t.Fatalf("second AcceptInvite: err = %v, want ErrInviteUsed", err)
	}
	_ = tx.Rollback(ctx)

	expiring, err := store.CreateInvite(ctx, "b@example.com", "EUR", "user")
	if err != nil {
		t.Fatal(err)
	}
	*now = now.Add(72*time.Hour + time.Second)
	if _, err := store.CheckInvite(ctx, expiring); !errors.Is(err, users.ErrInviteExpired) {
		t.Fatalf("CheckInvite expired: err = %v, want ErrInviteExpired", err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := store.AcceptInvite(ctx, tx, expiring); !errors.Is(err, users.ErrInviteExpired) {
		t.Fatalf("AcceptInvite expired: err = %v, want ErrInviteExpired", err)
	}
}

func TestResetTOTP(t *testing.T) {
	ctx := context.Background()
	store, pool, _ := newStore(t)

	var userID string
	err := pool.QueryRow(ctx,
		`INSERT INTO users (id, email, password_hash, totp_secret_enc, totp_enabled, totp_last_step, role)
		 VALUES (gen_random_uuid(), 'a@example.com', 'x', '\x01', true, 42, 'admin')
		 RETURNING id::text`).Scan(&userID)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := users.SeedDefaults(ctx, tx, userID, "BGN"); err != nil {
		t.Fatalf("SeedDefaults: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, '\x01'), ($1, '\x02')`, userID)
	if err != nil {
		t.Fatalf("insert recovery codes: %v", err)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, device_name, expires_at)
		 VALUES (gen_random_uuid(), $1, gen_random_uuid(), '\x01', 'iPhone', now() + interval '1 day'),
		        (gen_random_uuid(), $1, gen_random_uuid(), '\x02', 'Web', now() + interval '1 day')`, userID)
	if err != nil {
		t.Fatalf("insert refresh tokens: %v", err)
	}

	token, err := store.ResetTOTP(ctx, "A@example.com")
	if err != nil {
		t.Fatalf("ResetTOTP: %v", err)
	}

	var (
		secret   []byte
		enabled  bool
		lastStep *int64
	)
	err = pool.QueryRow(ctx,
		`SELECT totp_secret_enc, totp_enabled, totp_last_step FROM users WHERE id = $1`, userID).
		Scan(&secret, &enabled, &lastStep)
	if err != nil {
		t.Fatal(err)
	}
	if secret != nil || enabled || lastStep != nil {
		t.Fatalf("user after reset: secret=%v enabled=%v last_step=%v", secret, enabled, lastStep)
	}

	var codes, active int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM recovery_codes WHERE user_id = $1`, userID).Scan(&codes); err != nil {
		t.Fatal(err)
	}
	if codes != 0 {
		t.Fatalf("%d recovery codes left, want 0", codes)
	}
	err = pool.QueryRow(ctx,
		`SELECT count(*) FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, userID).Scan(&active)
	if err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatalf("%d refresh tokens not revoked, want 0", active)
	}

	inv, err := store.CheckInvite(ctx, token)
	if err != nil {
		t.Fatalf("CheckInvite of the reset invite: %v", err)
	}
	if inv.Email != "a@example.com" || inv.Role != "admin" || inv.CurrencyCode != "BGN" {
		t.Fatalf("reset invite = %+v", inv)
	}

	second, err := store.ResetTOTP(ctx, "a@example.com")
	if err != nil {
		t.Fatalf("second ResetTOTP: %v", err)
	}
	if _, err := store.CheckInvite(ctx, token); !errors.Is(err, users.ErrInviteUsed) {
		t.Fatalf("older reset invite after a new reset: err = %v, want ErrInviteUsed", err)
	}
	if _, err := store.CheckInvite(ctx, second); err != nil {
		t.Fatalf("CheckInvite of the new reset invite: %v", err)
	}

	if _, err := store.ResetTOTP(ctx, "nobody@example.com"); !errors.Is(err, users.ErrUserNotFound) {
		t.Fatalf("ResetTOTP unknown email: err = %v, want ErrUserNotFound", err)
	}
}

func TestUserIDByEmail(t *testing.T) {
	ctx := context.Background()
	store, pool, _ := newStore(t)

	var want string
	err := pool.QueryRow(ctx,
		`INSERT INTO users (id, email, password_hash, role)
		 VALUES (gen_random_uuid(), 'a@example.com', 'x', 'user') RETURNING id::text`).Scan(&want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.UserIDByEmail(ctx, "A@Example.com")
	if err != nil {
		t.Fatalf("UserIDByEmail: %v", err)
	}
	if got != want {
		t.Fatalf("UserIDByEmail = %q, want %q", got, want)
	}
	if _, err := store.UserIDByEmail(ctx, "b@example.com"); !errors.Is(err, users.ErrUserNotFound) {
		t.Fatalf("unknown email: err = %v, want ErrUserNotFound", err)
	}
}
