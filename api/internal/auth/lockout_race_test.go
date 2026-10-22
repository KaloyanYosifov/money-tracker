package auth_test

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

// Concurrent wrong passwords must not get more than MaxFailedLogins tries
// before the lock.
func TestLockoutConcurrentPasswords(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	lockout := auth.NewLockout(pool)
	hash, err := auth.HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	userID := insertUser(t, pool, "race@example.com")

	const n = 10
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { errs[i] = lockout.CheckPassword(ctx, userID, "wrong password!", hash) })
	}
	wg.Wait()

	var bad, locked int
	for _, err := range errs {
		switch {
		case errors.Is(err, auth.ErrBadPassword):
			bad++
		case errors.Is(err, auth.ErrLocked):
			locked++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if bad != auth.MaxFailedLogins || locked != n-auth.MaxFailedLogins {
		t.Errorf("bad = %d, locked = %d, want %d and %d", bad, locked, auth.MaxFailedLogins, n-auth.MaxFailedLogins)
	}
}

// Concurrent wrong TOTP codes must not get more than MaxFailedLogins tries
// before the lock.
func TestLoginTOTPConcurrentGuesses(t *testing.T) {
	env := newAuthEnv(t, true)
	u := env.register("a@example.com")
	env.advance(30 * time.Second)
	mfa := env.mfaToken("a@example.com")

	// A code that matches none of the accepted steps.
	var valid []string
	for d := -1; d <= 1; d++ {
		c, err := totp.GenerateCode(u.secret, env.now.Add(time.Duration(d)*30*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		valid = append(valid, c)
	}
	wrong := "000000"
	for slices.Contains(valid, wrong) {
		wrong = string(rune(wrong[0]+1)) + wrong[1:]
	}

	const n = 15
	reqs := make([]*http.Request, n)
	for i := range reqs {
		reqs[i] = env.request("POST", "/api/auth/login/totp", map[string]string{"mfa_token": mfa, "code": wrong})
	}
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { codes[i] = env.serve(reqs[i]).Code })
	}
	wg.Wait()

	var invalid, locked int
	for _, c := range codes {
		switch c {
		case http.StatusUnauthorized:
			invalid++
		case http.StatusTooManyRequests:
			locked++
		default:
			t.Fatalf("unexpected status %d", c)
		}
	}
	if invalid != auth.MaxFailedLogins {
		t.Errorf("invalid_code answers = %d, locked = %d, want %d checked codes", invalid, locked, auth.MaxFailedLogins)
	}
}

// CheckPassword counts each attempt before the slow check. A correct
// password must take that count back, also when it is the attempt that would
// lock the user.
func TestLockoutCorrectPasswordTakesBackFailure(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	lockout := auth.NewLockout(pool)
	const password = "correct horse battery"
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	userID := insertUser(t, pool, "undo@example.com")

	if err := lockout.CheckPassword(ctx, userID, password, hash); err != nil {
		t.Fatalf("correct password: %v", err)
	}
	if u := readLockout(t, pool, userID); u.failedLogins != 0 || u.lockedUntil != nil {
		t.Fatalf("after success: failed_logins = %d, locked_until = %v", u.failedLogins, u.lockedUntil)
	}

	for range auth.MaxFailedLogins - 1 {
		if err := lockout.CheckPassword(ctx, userID, "wrong password!", hash); !errors.Is(err, auth.ErrBadPassword) {
			t.Fatalf("wrong password: err = %v", err)
		}
	}
	if err := lockout.CheckPassword(ctx, userID, password, hash); err != nil {
		t.Fatalf("correct password on the last try: %v", err)
	}
	if u := readLockout(t, pool, userID); u.failedLogins != auth.MaxFailedLogins-1 || u.lockedUntil != nil {
		t.Fatalf("after last-try success: failed_logins = %d, locked_until = %v", u.failedLogins, u.lockedUntil)
	}
	if err := lockout.CheckPassword(ctx, userID, "wrong password!", hash); !errors.Is(err, auth.ErrBadPassword) {
		t.Fatalf("wrong password: err = %v", err)
	}
	if err := lockout.Check(ctx, userID); !errors.Is(err, auth.ErrLocked) {
		t.Fatalf("Check after %d failures: err = %v, want ErrLocked", auth.MaxFailedLogins, err)
	}
}
