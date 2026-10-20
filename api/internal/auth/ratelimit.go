package auth

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"
)

const (
	// LoginAttemptsPerMinute is the number of auth requests that one IP can
	// send in one minute.
	LoginAttemptsPerMinute = 10
	// MaxFailedLogins is the number of failed password or TOTP checks that
	// locks a user.
	MaxFailedLogins = 5
	// LockoutDuration is the time that a locked user cannot log in.
	LockoutDuration = 15 * time.Minute

	idleLimiterTTL = 10 * time.Minute
)

var (
	ErrLocked      = errors.New("user is locked")
	ErrBadPassword = errors.New("password does not match")
)

type ipEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// IPLimiter keeps one token bucket per client IP in memory. The API runs as
// one replica, so the state does not need to be shared.
type IPLimiter struct {
	mu          sync.Mutex
	entries     map[string]*ipEntry
	lastCleanup time.Time
}

func NewIPLimiter() *IPLimiter {
	return &IPLimiter{entries: map[string]*ipEntry{}}
}

// Allow reports whether the IP can make one more attempt at the time now.
// Each 10 minutes it removes the entries that were idle for 10 minutes.
func (l *IPLimiter) Allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if now.Sub(l.lastCleanup) >= idleLimiterTTL {
		for k, e := range l.entries {
			if now.Sub(e.lastSeen) >= idleLimiterTTL {
				delete(l.entries, k)
			}
		}
		l.lastCleanup = now
	}

	e, ok := l.entries[ip]
	if !ok {
		e = &ipEntry{limiter: rate.NewLimiter(rate.Every(time.Minute/LoginAttemptsPerMinute), LoginAttemptsPerMinute)}
		l.entries[ip] = e
	}
	e.lastSeen = now
	return e.limiter.AllowN(now, 1)
}

// limiterKey returns the key of the IP in the IPLimiter. An IPv6 client
// usually gets a full /64, so all addresses in one /64 share one bucket.
func limiterKey(ip netip.Addr) string {
	if ip.Is6() {
		return netip.PrefixFrom(ip, 64).Masked().String()
	}
	return ip.String()
}

// Len returns the number of IPs in memory.
func (l *IPLimiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}

// Lockout keeps the failed login count and the lock of each user in the
// users table. Password and TOTP failures use the same count.
type Lockout struct {
	pool *pgxpool.Pool
	Now  func() time.Time
}

func NewLockout(pool *pgxpool.Pool) *Lockout {
	return &Lockout{pool: pool, Now: time.Now}
}

// Check returns ErrLocked if the user is locked now.
func (l *Lockout) Check(ctx context.Context, userID string) error {
	var lockedUntil *time.Time
	err := l.pool.QueryRow(ctx, `SELECT locked_until FROM users WHERE id = $1`, userID).Scan(&lockedUntil)
	if err != nil {
		return fmt.Errorf("read lockout: %w", err)
	}
	if lockedUntil != nil && lockedUntil.After(l.Now()) {
		return ErrLocked
	}
	return nil
}

// CheckPassword returns ErrLocked for a locked user, also if the password is
// correct. A wrong password counts as a failure and returns ErrBadPassword.
// A correct password does not reset the count, because the login is not
// complete before the TOTP step. Call Reset after the full login.
func (l *Lockout) CheckPassword(ctx context.Context, userID, password, hash string) error {
	if err := l.Check(ctx, userID); err != nil {
		return err
	}
	if VerifyPassword(password, hash) {
		return nil
	}
	if err := l.RecordFailure(ctx, userID); err != nil {
		return err
	}
	return ErrBadPassword
}

// RecordFailure adds one failure. The failure that reaches MaxFailedLogins
// locks the user for LockoutDuration and sets the count back to zero.
func (l *Lockout) RecordFailure(ctx context.Context, userID string) error {
	_, err := l.pool.Exec(ctx, `
		UPDATE users SET
			failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
			locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN $3 ELSE locked_until END
		WHERE id = $1`,
		userID, MaxFailedLogins, l.Now().Add(LockoutDuration))
	if err != nil {
		return fmt.Errorf("record login failure: %w", err)
	}
	return nil
}

// Reset clears the failure count and the lock after a successful login.
func (l *Lockout) Reset(ctx context.Context, userID string) error {
	_, err := l.pool.Exec(ctx,
		`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, userID)
	if err != nil {
		return fmt.Errorf("reset lockout: %w", err)
	}
	return nil
}
