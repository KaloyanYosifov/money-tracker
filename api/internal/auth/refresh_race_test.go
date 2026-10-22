package auth_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
)

// rotateHeld does the writes of a rotation of the session in an open
// transaction, as Rotate does, and returns a function that commits it.
func rotateHeld(t *testing.T, pool *pgxpool.Pool, userID, sessionID string) func() {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	var oldID string
	steps := []func() error{
		func() error {
			_, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR KEY SHARE`, userID)
			return err
		},
		func() error {
			return tx.QueryRow(ctx,
				`SELECT id::text FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL FOR UPDATE`,
				sessionID).Scan(&oldID)
		},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, device_name, expires_at)
				 VALUES (gen_random_uuid(), $1, $2, gen_random_uuid()::text::bytea, 'iPhone', now() + interval '1 day')`,
				userID, sessionID)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx, `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, oldID)
			return err
		},
	}
	for _, step := range steps {
		if err := step(); err != nil {
			t.Fatal(err)
		}
	}
	return func() {
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

// waitForLock waits until a backend waits for a lock.
func waitForLock(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		err := pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`).Scan(&n)
		if err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no backend waits for a lock")
}

func activeTokens(t *testing.T, pool *pgxpool.Pool, userID string) int {
	t.Helper()
	var n int
	err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, userID).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// A revoke that runs while the same session rotates must also end the new
// token of the rotation.
func TestRevokeDuringRotate(t *testing.T) {
	ctx := context.Background()
	store, pool, _ := newRefreshStore(t)

	cases := map[string]func(userID string, rt auth.RefreshToken) error{
		"revoke_session": func(userID string, rt auth.RefreshToken) error {
			return store.RevokeSession(ctx, userID, rt.SessionID)
		},
		"revoke_all": func(userID string, _ auth.RefreshToken) error {
			return store.RevokeAllForUser(ctx, userID)
		},
		"logout": func(_ string, rt auth.RefreshToken) error {
			return store.Revoke(ctx, rt.Token)
		},
	}
	for name, revoke := range cases {
		t.Run(name, func(t *testing.T) {
			userID := insertUser(t, pool, name+"@example.com")
			rt, err := store.Create(ctx, userID, "iPhone")
			if err != nil {
				t.Fatal(err)
			}
			commit := rotateHeld(t, pool, userID, rt.SessionID)

			done := make(chan error, 1)
			go func() { done <- revoke(userID, rt) }()
			waitForLock(t, pool)
			commit()
			if err := <-done; err != nil {
				t.Fatalf("revoke: %v", err)
			}
			if n := activeTokens(t, pool, userID); n != 0 {
				t.Errorf("active tokens = %d, want 0: the rotated token outlived the revoke", n)
			}
		})
	}
}
