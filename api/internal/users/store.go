// Package users keeps users and invites and seeds the default data of a new user.
package users

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// InviteTTL is the time an invite stays valid.
const InviteTTL = 72 * time.Hour

var (
	ErrInviteInvalid = errors.New("invite is not valid")
	ErrInviteExpired = errors.New("invite expired")
	ErrInviteUsed    = errors.New("invite was already used")
	ErrUserNotFound  = errors.New("user not found")
)

var currencyCode = regexp.MustCompile(`^[A-Z]{3}$`)

// Invite is the data that an invite carries.
type Invite struct {
	Email        string
	CurrencyCode string
	Role         string
	ExpiresAt    time.Time
}

// querier is the part of pgxpool.Pool and pgx.Tx that the store uses.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Store keeps users and invites. It stores only the SHA-256 of each invite token.
type Store struct {
	pool *pgxpool.Pool
	Now  func() time.Time
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool, Now: time.Now}
}

// CreateInvite stores a new invite and returns its plain token.
func (s *Store) CreateInvite(ctx context.Context, email, currency, role string) (string, error) {
	return s.createInvite(ctx, s.pool, email, currency, role)
}

func (s *Store) createInvite(ctx context.Context, q querier, email, currency, role string) (string, error) {
	email = strings.TrimSpace(email)
	if email == "" {
		return "", errors.New("email is required")
	}
	if !currencyCode.MatchString(currency) {
		return "", fmt.Errorf("currency %q is not an ISO 4217 code", currency)
	}
	if role != "admin" && role != "user" {
		return "", fmt.Errorf("role %q is not admin or user", role)
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	// Only the newest invite for an email stays valid. An older link cannot
	// take over the account after a TOTP reset.
	_, err := q.Exec(ctx,
		`UPDATE invites SET used_at = $2 WHERE email = $1 AND used_at IS NULL`, email, s.Now())
	if err != nil {
		return "", fmt.Errorf("invalidate old invites: %w", err)
	}
	_, err = q.Exec(ctx,
		`INSERT INTO invites (token_hash, email, currency_code, role, expires_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		hashInviteToken(token), email, currency, role, s.Now().Add(InviteTTL))
	if err != nil {
		return "", fmt.Errorf("insert invite: %w", err)
	}
	return token, nil
}

// CheckInvite returns the invite of the token if it is not used and not expired.
// It does not use the invite.
func (s *Store) CheckInvite(ctx context.Context, token string) (Invite, error) {
	return s.loadInvite(ctx, s.pool, token, "")
}

// AcceptInvite marks the invite as used inside tx and returns it. It locks the
// invite row, so two concurrent accepts cannot both succeed.
func (s *Store) AcceptInvite(ctx context.Context, tx pgx.Tx, token string) (Invite, error) {
	inv, err := s.loadInvite(ctx, tx, token, " FOR UPDATE")
	if err != nil {
		return Invite{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE invites SET used_at = $2 WHERE token_hash = $1`,
		hashInviteToken(token), s.Now())
	if err != nil {
		return Invite{}, fmt.Errorf("mark invite used: %w", err)
	}
	return inv, nil
}

func (s *Store) loadInvite(ctx context.Context, q querier, token, lock string) (Invite, error) {
	var (
		inv    Invite
		usedAt *time.Time
	)
	err := q.QueryRow(ctx,
		`SELECT email::text, currency_code, role, expires_at, used_at
		 FROM invites WHERE token_hash = $1`+lock, hashInviteToken(token)).
		Scan(&inv.Email, &inv.CurrencyCode, &inv.Role, &inv.ExpiresAt, &usedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Invite{}, ErrInviteInvalid
	}
	if err != nil {
		return Invite{}, fmt.Errorf("read invite: %w", err)
	}
	if usedAt != nil {
		return Invite{}, ErrInviteUsed
	}
	if !s.Now().Before(inv.ExpiresAt) {
		return Invite{}, ErrInviteExpired
	}
	return inv, nil
}

// UserIDByEmail returns the ID of the user with this email. The match ignores case.
func (s *Store) UserIDByEmail(ctx context.Context, email string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM users WHERE email = $1`,
		strings.TrimSpace(email)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUserNotFound
	}
	if err != nil {
		return "", fmt.Errorf("find user: %w", err)
	}
	return id, nil
}

// ResetTOTP removes the TOTP secret and the recovery codes of the user, ends
// all sessions and returns a new invite token for the same email and role.
// The user accepts the invite to set a new password and TOTP.
func (s *Store) ResetTOTP(ctx context.Context, email string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// FOR UPDATE waits for a running token rotation (see auth.RefreshStore),
	// so that the revoke below also ends the new token.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE email = $1 FOR UPDATE`, strings.TrimSpace(email)); err != nil {
		return "", fmt.Errorf("lock user: %w", err)
	}
	var userID, userEmail, role string
	err = tx.QueryRow(ctx,
		`UPDATE users SET totp_secret_enc = NULL, totp_enabled = false, totp_last_step = NULL
		 WHERE email = $1 RETURNING id::text, email::text, role`,
		strings.TrimSpace(email)).Scan(&userID, &userEmail, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUserNotFound
	}
	if err != nil {
		return "", fmt.Errorf("clear totp: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM recovery_codes WHERE user_id = $1`, userID); err != nil {
		return "", fmt.Errorf("delete recovery codes: %w", err)
	}
	_, err = tx.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID, s.Now())
	if err != nil {
		return "", fmt.Errorf("revoke sessions: %w", err)
	}

	// A user who never finished the setup has no settings yet. The currency
	// then comes from the last invite for the email.
	var currency *string
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(
		   (SELECT currency_code FROM user_settings WHERE user_id = $1),
		   (SELECT currency_code FROM invites WHERE email = $2 ORDER BY expires_at DESC LIMIT 1))`,
		userID, userEmail).Scan(&currency)
	if err != nil {
		return "", fmt.Errorf("find currency: %w", err)
	}
	if currency == nil {
		return "", fmt.Errorf("no currency found for %s", userEmail)
	}

	token, err := s.createInvite(ctx, tx, userEmail, *currency, role)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return token, nil
}

func hashInviteToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
