package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RefreshTokenTTL is the lifetime of a refresh token after its last use.
const RefreshTokenTTL = 90 * 24 * time.Hour

var (
	ErrTokenInvalid    = errors.New("refresh token is not valid")
	ErrTokenExpired    = errors.New("refresh token expired")
	ErrTokenReused     = errors.New("refresh token was used again after rotation")
	ErrSessionNotFound = errors.New("session not found")
)

// RefreshToken is a new plain refresh token. SessionID is the token family:
// it stays the same over all rotations of one login.
type RefreshToken struct {
	Token     string
	UserID    string
	SessionID string
}

// Session is one active login of a user.
type Session struct {
	ID         string
	DeviceName string
	CreatedAt  time.Time
	LastUsedAt time.Time
	Current    bool
}

// RefreshStore keeps refresh tokens in the refresh_tokens table. It stores
// only the SHA-256 of each token.
type RefreshStore struct {
	pool *pgxpool.Pool
	Now  func() time.Time
}

func NewRefreshStore(pool *pgxpool.Pool) *RefreshStore {
	return &RefreshStore{pool: pool, Now: time.Now}
}

// Create starts a new session for the user and returns its first token.
func (s *RefreshStore) Create(ctx context.Context, userID, deviceName string) (RefreshToken, error) {
	token, hash, err := newRefreshToken()
	if err != nil {
		return RefreshToken{}, err
	}
	now := s.Now()
	var familyID string
	err = s.pool.QueryRow(ctx,
		`INSERT INTO refresh_tokens
		   (id, user_id, family_id, token_hash, device_name, created_at, last_used_at, expires_at)
		 VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, $3, $4, $4, $5)
		 RETURNING family_id::text`,
		userID, hash, deviceName, now, now.Add(RefreshTokenTTL)).Scan(&familyID)
	if err != nil {
		return RefreshToken{}, fmt.Errorf("insert refresh token: %w", err)
	}
	return RefreshToken{Token: token, UserID: userID, SessionID: familyID}, nil
}

// Rotate replaces the token with a new token of the same session. If the
// token was already rotated, Rotate revokes the whole session and returns
// ErrTokenReused.
func (s *RefreshStore) Rotate(ctx context.Context, token string) (RefreshToken, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RefreshToken{}, err
	}
	defer tx.Rollback(ctx)

	now := s.Now()
	var (
		id, userID, familyID, deviceName string
		createdAt, expiresAt             time.Time
		revokedAt                        *time.Time
		replacedBy                       *string
	)
	err = tx.QueryRow(ctx,
		`SELECT id::text, user_id::text, family_id::text, device_name, created_at,
		        expires_at, revoked_at, replaced_by::text
		 FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
		hashRefreshToken(token)).
		Scan(&id, &userID, &familyID, &deviceName, &createdAt, &expiresAt, &revokedAt, &replacedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return RefreshToken{}, ErrTokenInvalid
	}
	if err != nil {
		return RefreshToken{}, fmt.Errorf("select refresh token: %w", err)
	}

	if revokedAt != nil {
		if replacedBy == nil {
			return RefreshToken{}, ErrTokenInvalid
		}
		if _, err := tx.Exec(ctx,
			`UPDATE refresh_tokens SET revoked_at = $2
			 WHERE family_id = $1 AND revoked_at IS NULL`, familyID, now); err != nil {
			return RefreshToken{}, fmt.Errorf("revoke family: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return RefreshToken{}, err
		}
		return RefreshToken{}, ErrTokenReused
	}
	if !now.Before(expiresAt) {
		return RefreshToken{}, ErrTokenExpired
	}

	newToken, newHash, err := newRefreshToken()
	if err != nil {
		return RefreshToken{}, err
	}
	var newID string
	err = tx.QueryRow(ctx,
		`INSERT INTO refresh_tokens
		   (id, user_id, family_id, token_hash, device_name, created_at, last_used_at, expires_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
		 RETURNING id::text`,
		userID, familyID, newHash, deviceName, createdAt, now, now.Add(RefreshTokenTTL)).Scan(&newID)
	if err != nil {
		return RefreshToken{}, fmt.Errorf("insert rotated token: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3, last_used_at = $2
		 WHERE id = $1`, id, now, newID); err != nil {
		return RefreshToken{}, fmt.Errorf("revoke old token: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RefreshToken{}, err
	}
	return RefreshToken{Token: newToken, UserID: userID, SessionID: familyID}, nil
}

// Revoke ends the session of the token (logout). An unknown or already
// revoked token is not an error.
func (s *RefreshStore) Revoke(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = $2
		 WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
		   AND revoked_at IS NULL`,
		hashRefreshToken(token), s.Now())
	if err != nil {
		return fmt.Errorf("revoke refresh token: %w", err)
	}
	return nil
}

// RevokeSession ends one session of the user. It returns ErrSessionNotFound
// if the user has no active session with this ID.
func (s *RefreshStore) RevokeSession(ctx context.Context, userID, sessionID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = $3
		 WHERE user_id::text = $1 AND family_id::text = $2 AND revoked_at IS NULL`,
		userID, sessionID, s.Now())
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// RevokeAllForUser ends all sessions of the user.
func (s *RefreshStore) RevokeAllForUser(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = $2
		 WHERE user_id = $1 AND revoked_at IS NULL`, userID, s.Now())
	if err != nil {
		return fmt.Errorf("revoke all sessions: %w", err)
	}
	return nil
}

// ListSessions returns the active sessions of the user. The session with
// the ID currentSessionID has Current set.
func (s *RefreshStore) ListSessions(ctx context.Context, userID, currentSessionID string) ([]Session, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT family_id::text, device_name, created_at, last_used_at
		 FROM refresh_tokens
		 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
		 ORDER BY last_used_at DESC`, userID, s.Now())
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	sessions, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Session, error) {
		var ses Session
		err := row.Scan(&ses.ID, &ses.DeviceName, &ses.CreatedAt, &ses.LastUsedAt)
		ses.Current = ses.ID == currentSessionID
		return ses, err
	})
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	return sessions, nil
}

func newRefreshToken() (token string, hash []byte, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, hashRefreshToken(token), nil
}

func hashRefreshToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
