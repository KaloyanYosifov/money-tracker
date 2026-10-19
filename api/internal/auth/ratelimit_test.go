package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

func TestIPLimiter(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	l := auth.NewIPLimiter()

	for i := range 10 {
		if !l.Allow("192.0.2.1", now) {
			t.Fatalf("attempt %d was refused", i+1)
		}
	}
	if l.Allow("192.0.2.1", now) {
		t.Fatal("attempt 11 was allowed")
	}
	if !l.Allow("192.0.2.2", now) {
		t.Fatal("another IP was refused")
	}

	later := now.Add(time.Minute)
	for i := range 10 {
		if !l.Allow("192.0.2.1", later) {
			t.Fatalf("attempt %d after a minute was refused", i+1)
		}
	}
	if l.Allow("192.0.2.1", later) {
		t.Fatal("attempt 11 after a minute was allowed")
	}
}

func TestIPLimiterRemovesIdleEntries(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	l := auth.NewIPLimiter()
	l.Allow("192.0.2.1", now)
	l.Allow("192.0.2.2", now.Add(11*time.Minute))
	if n := l.Len(); n != 1 {
		t.Fatalf("Len = %d, want 1", n)
	}
}

type lockoutUser struct {
	failedLogins int
	lockedUntil  *time.Time
}

func readLockout(t *testing.T, pool *pgxpool.Pool, userID string) lockoutUser {
	t.Helper()
	var u lockoutUser
	err := pool.QueryRow(context.Background(),
		`SELECT failed_logins, locked_until FROM users WHERE id = $1`, userID).
		Scan(&u.failedLogins, &u.lockedUntil)
	if err != nil {
		t.Fatalf("read user: %v", err)
	}
	return u
}

func TestUserLockout(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	lockout := auth.NewLockout(pool)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	lockout.Now = func() time.Time { return now }

	const password = "correct horse battery"
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	userID := insertUser(t, pool, "lock@example.com")

	t.Run("five password failures lock the user", func(t *testing.T) {
		for i := range 5 {
			err := lockout.CheckPassword(ctx, userID, "wrong password!", hash)
			if !errors.Is(err, auth.ErrBadPassword) {
				t.Fatalf("failure %d: err = %v, want ErrBadPassword", i+1, err)
			}
		}
		u := readLockout(t, pool, userID)
		if u.lockedUntil == nil || !u.lockedUntil.Equal(now.Add(15*time.Minute)) {
			t.Fatalf("locked_until = %v, want %v", u.lockedUntil, now.Add(15*time.Minute))
		}
		if err := lockout.CheckPassword(ctx, userID, password, hash); !errors.Is(err, auth.ErrLocked) {
			t.Fatalf("correct password during lock: err = %v, want ErrLocked", err)
		}
	})

	t.Run("the lock ends after 15 minutes", func(t *testing.T) {
		now = now.Add(15 * time.Minute)
		if err := lockout.CheckPassword(ctx, userID, password, hash); err != nil {
			t.Fatalf("CheckPassword after lock: %v", err)
		}
	})

	t.Run("a success resets failed_logins", func(t *testing.T) {
		for range 3 {
			_ = lockout.CheckPassword(ctx, userID, "wrong password!", hash)
		}
		if u := readLockout(t, pool, userID); u.failedLogins != 3 {
			t.Fatalf("failed_logins = %d, want 3", u.failedLogins)
		}
		if err := lockout.Reset(ctx, userID); err != nil {
			t.Fatalf("Reset: %v", err)
		}
		u := readLockout(t, pool, userID)
		if u.failedLogins != 0 || u.lockedUntil != nil {
			t.Fatalf("after Reset: failed_logins = %d, locked_until = %v", u.failedLogins, u.lockedUntil)
		}
	})

	t.Run("TOTP failures count with password failures", func(t *testing.T) {
		for range 2 {
			_ = lockout.CheckPassword(ctx, userID, "wrong password!", hash)
		}
		for range 3 {
			if err := lockout.RecordFailure(ctx, userID); err != nil {
				t.Fatalf("RecordFailure: %v", err)
			}
		}
		if err := lockout.Check(ctx, userID); !errors.Is(err, auth.ErrLocked) {
			t.Fatalf("Check: err = %v, want ErrLocked", err)
		}
		u := readLockout(t, pool, userID)
		if u.lockedUntil == nil || !u.lockedUntil.Equal(now.Add(15*time.Minute)) {
			t.Fatalf("locked_until = %v, want %v", u.lockedUntil, now.Add(15*time.Minute))
		}
	})
}
