package auth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	AccessTokenTTL = 10 * time.Minute
	MFATokenTTL    = 5 * time.Minute

	audAPI       = "mt-api"
	audPowerSync = "mt-powersync"
	audMFA       = "mt-mfa"
)

// Tokens signs and checks the EdDSA JWTs of the API.
type Tokens struct {
	key    ed25519.PrivateKey
	issuer string
	kid    string
	jwks   []byte
}

// NewTokens makes a Tokens for the key and the issuer. The kid is the first
// 16 characters of the base64url SHA-256 of the public key.
func NewTokens(key ed25519.PrivateKey, issuer string) *Tokens {
	pub := key.Public().(ed25519.PublicKey)
	sum := sha256.Sum256(pub)
	kid := base64.RawURLEncoding.EncodeToString(sum[:])[:16]

	jwks, err := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kty": "OKP",
			"crv": "Ed25519",
			"x":   base64.RawURLEncoding.EncodeToString(pub),
			"kid": kid,
			"use": "sig",
			"alg": "EdDSA",
		}},
	})
	if err != nil {
		panic(err)
	}
	return &Tokens{key: key, issuer: issuer, kid: kid, jwks: jwks}
}

// KID returns the key ID in the token header and in the JWKS.
func (t *Tokens) KID() string { return t.kid }

// JWKS returns the JSON Web Key Set with the public key only.
func (t *Tokens) JWKS() []byte { return t.jwks }

// IssueAccessToken returns an access token for the API and PowerSync.
func (t *Tokens) IssueAccessToken(userID string, now time.Time) (string, error) {
	return t.issue(userID, []string{audAPI, audPowerSync}, now, AccessTokenTTL)
}

// IssueMFAToken returns a short token that only the TOTP step accepts.
func (t *Tokens) IssueMFAToken(userID string, now time.Time) (string, error) {
	return t.issue(userID, []string{audMFA}, now, MFATokenTTL)
}

// ParseAccessToken checks an access token and returns the user ID.
func (t *Tokens) ParseAccessToken(token string, now time.Time) (string, error) {
	return t.parse(token, audAPI, now)
}

// ParseMFAToken checks an MFA token and returns the user ID.
func (t *Tokens) ParseMFAToken(token string, now time.Time) (string, error) {
	return t.parse(token, audMFA, now)
}

func (t *Tokens) issue(userID string, aud []string, now time.Time, ttl time.Duration) (string, error) {
	claims := jwt.RegisteredClaims{
		Issuer:    t.issuer,
		Subject:   userID,
		Audience:  aud,
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = t.kid
	return tok.SignedString(t.key)
}

func (t *Tokens) parse(token, aud string, now time.Time) (string, error) {
	var claims jwt.RegisteredClaims
	_, err := jwt.ParseWithClaims(token, &claims,
		func(*jwt.Token) (any, error) { return t.key.Public(), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(t.issuer),
		jwt.WithAudience(aud),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	if err != nil {
		return "", err
	}
	if claims.Subject == "" {
		return "", errors.New("token has no subject")
	}
	return claims.Subject, nil
}
