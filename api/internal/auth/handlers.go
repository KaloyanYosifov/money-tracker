package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

const (
	// RefreshCookieName is the cookie that keeps the refresh token on the web.
	RefreshCookieName = "mt_refresh"
	refreshCookiePath = "/api/auth"

	nativeClientHeader = "X-Client"
	csrfHeader         = "X-Requested-With"
	csrfHeaderValue    = "money-tracker"
	deviceNameHeader   = "X-Device-Name"
	maxDeviceNameRunes = 100
)

// Deps are the parts that the auth handlers use.
type Deps struct {
	Pool         *pgxpool.Pool
	Tokens       *Tokens
	TOTPKey      []byte
	CookieSecure bool
	// TOTPDisabled skips the TOTP step at login and at invite confirm.
	TOTPDisabled bool
	// ClientIP returns the IP of the client for the rate limit.
	ClientIP func(*http.Request) netip.Addr
	// Now is the clock of the handlers and of their stores. Nil means time.Now.
	Now func() time.Time
}

// Handlers serve the /api/auth routes and the JWKS.
type Handlers struct {
	pool         *pgxpool.Pool
	tokens       *Tokens
	totpKey      []byte
	cookieSecure bool
	totpDisabled bool
	clientIP     func(*http.Request) netip.Addr
	now          func() time.Time

	users   *users.Store
	refresh *RefreshStore
	lockout *Lockout
	limiter *IPLimiter
}

func NewHandlers(d Deps) *Handlers {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	h := &Handlers{
		pool:         d.Pool,
		tokens:       d.Tokens,
		totpKey:      d.TOTPKey,
		cookieSecure: d.CookieSecure,
		totpDisabled: d.TOTPDisabled,
		clientIP:     d.ClientIP,
		now:          now,
		users:        users.NewStore(d.Pool),
		refresh:      NewRefreshStore(d.Pool),
		lockout:      NewLockout(d.Pool),
		limiter:      NewIPLimiter(),
	}
	h.users.Now = now
	h.refresh.Now = now
	h.lockout.Now = now
	return h
}

// Register adds the routes to mux.
func (h *Handlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/.well-known/jwks.json", h.jwks)
	mux.HandleFunc("POST /api/auth/invite/accept", h.inviteAccept)
	mux.HandleFunc("POST /api/auth/invite/confirm", h.inviteConfirm)
	mux.HandleFunc("POST /api/auth/login", h.rateLimited(h.login))
	mux.HandleFunc("POST /api/auth/login/totp", h.rateLimited(h.loginTOTP))
	mux.HandleFunc("POST /api/auth/refresh", h.rateLimited(h.refreshToken))
	mux.HandleFunc("POST /api/auth/logout", h.logout)
	mux.Handle("GET /api/auth/sessions", h.RequireUser(http.HandlerFunc(h.listSessions)))
	mux.Handle("DELETE /api/auth/sessions/{id}", h.RequireUser(http.HandlerFunc(h.revokeSession)))
}

// dummyHash is the hash that login checks for an unknown email, so that the
// answer takes the same time as for a known email.
var dummyHash = sync.OnceValue(func() string {
	hash, err := HashPassword("dummy password for unknown emails")
	if err != nil {
		panic(err)
	}
	return hash
})

func (h *Handlers) rateLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.limiter.Allow(limiterKey(h.clientIP(r)), h.now()) {
			writeError(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next(w, r)
	}
}

func (h *Handlers) jwks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(h.tokens.JWKS())
}

func (h *Handlers) inviteAccept(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	inv, err := h.users.CheckInvite(ctx, req.Token)
	if err != nil {
		writeInviteError(w, err)
		return
	}
	hash, err := HashPassword(req.Password)
	if errors.Is(err, ErrPasswordTooShort) {
		writeError(w, http.StatusBadRequest, "password_too_short")
		return
	}
	if err != nil {
		writeInternal(w)
		return
	}

	tx, err := h.pool.Begin(ctx)
	if err != nil {
		writeInternal(w)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The invite has no user ID. A reset-TOTP invite is for a user who
	// exists, so the user is found by the invite email.
	var (
		userID  string
		enabled bool
		exists  = true
	)
	err = tx.QueryRow(ctx,
		`SELECT id::text, totp_enabled FROM users WHERE email = $1 FOR UPDATE`, inv.Email).
		Scan(&userID, &enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		exists = false
		err = tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&userID)
	}
	if err != nil {
		writeInternal(w)
		return
	}
	if enabled {
		writeError(w, http.StatusConflict, "already_registered")
		return
	}

	secret, otpURL, err := NewTOTPSecret(inv.Email)
	if err != nil {
		writeInternal(w)
		return
	}
	sealed, err := Seal(h.totpKey, []byte(secret), userID)
	if err != nil {
		writeInternal(w)
		return
	}
	if exists {
		_, err = tx.Exec(ctx,
			`UPDATE users SET password_hash = $2, totp_secret_enc = $3, totp_last_step = NULL, role = $4
			 WHERE id = $1`, userID, hash, sealed, inv.Role)
	} else {
		_, err = tx.Exec(ctx,
			`INSERT INTO users (id, email, password_hash, totp_secret_enc, role)
			 VALUES ($1, $2, $3, $4, $5)`, userID, inv.Email, hash, sealed, inv.Role)
	}
	if err != nil {
		writeInternal(w)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"otpauth_url":   otpURL,
		"secret":        secret,
		"totp_required": !h.totpDisabled,
	})
}

func (h *Handlers) inviteConfirm(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token      string `json:"token"`
		Code       string `json:"code"`
		DeviceName string `json:"device_name"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		writeInternal(w)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	inv, err := h.users.AcceptInvite(ctx, tx, req.Token)
	if err != nil {
		writeInviteError(w, err)
		return
	}
	var (
		userID  string
		sealed  []byte
		enabled bool
	)
	err = tx.QueryRow(ctx,
		`SELECT id::text, totp_secret_enc, totp_enabled FROM users WHERE email = $1 FOR UPDATE`,
		inv.Email).Scan(&userID, &sealed, &enabled)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (sealed == nil || enabled)) {
		writeError(w, http.StatusBadRequest, "invite_not_accepted")
		return
	}
	if err != nil {
		writeInternal(w)
		return
	}
	secret, err := Open(h.totpKey, sealed, userID)
	if err != nil {
		writeInternal(w)
		return
	}
	var step int64
	if !h.totpDisabled {
		var ok bool
		step, ok = Verify(string(secret), req.Code, h.now(), 0)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_code")
			return
		}
	}

	codes, hashes, err := GenerateRecoveryCodes()
	if err != nil {
		writeInternal(w)
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET totp_enabled = true, totp_last_step = $2 WHERE id = $1`, userID, step); err != nil {
		writeInternal(w)
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM recovery_codes WHERE user_id = $1`, userID); err != nil {
		writeInternal(w)
		return
	}
	for _, hash := range hashes {
		if _, err := tx.Exec(ctx,
			`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, userID, hash); err != nil {
			writeInternal(w)
			return
		}
	}
	if err := users.SeedDefaults(ctx, tx, userID, inv.CurrencyCode); err != nil {
		writeInternal(w)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternal(w)
		return
	}
	h.startSession(w, r, userID, deviceName(r, req.DeviceName), codes)
}

func (h *Handlers) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &req) {
		return
	}
	email := strings.TrimSpace(req.Email)
	if email == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	ctx := r.Context()
	var (
		userID, hash string
		enabled      bool
	)
	err := h.pool.QueryRow(ctx,
		`SELECT id::text, password_hash, totp_enabled FROM users WHERE email = $1`, email).
		Scan(&userID, &hash, &enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		VerifyPassword(req.Password, dummyHash())
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	if err != nil {
		writeInternal(w)
		return
	}

	switch err := h.lockout.CheckPassword(ctx, userID, req.Password, hash); {
	case errors.Is(err, ErrLocked):
		writeError(w, http.StatusTooManyRequests, "locked")
		return
	case errors.Is(err, ErrBadPassword):
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	case err != nil:
		writeInternal(w)
		return
	}
	if !enabled {
		writeError(w, http.StatusForbidden, "setup_incomplete")
		return
	}
	if h.totpDisabled {
		h.startSession(w, r, userID, deviceName(r, ""), nil)
		return
	}
	mfa, err := h.tokens.IssueMFAToken(userID, h.now())
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"mfa_token": mfa})
}

func (h *Handlers) loginTOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MFAToken     string `json:"mfa_token"`
		Code         string `json:"code"`
		RecoveryCode string `json:"recovery_code"`
		DeviceName   string `json:"device_name"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Code == "" && req.RecoveryCode == "" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	userID, err := h.tokens.ParseMFAToken(req.MFAToken, h.now())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "mfa_invalid")
		return
	}
	ctx := r.Context()
	if err := h.lockout.Check(ctx, userID); err != nil {
		if errors.Is(err, ErrLocked) {
			writeError(w, http.StatusTooManyRequests, "locked")
		} else {
			writeInternal(w)
		}
		return
	}

	ok, err := h.checkSecondFactor(ctx, userID, req.Code, req.RecoveryCode)
	if errors.Is(err, errSetupIncomplete) {
		writeError(w, http.StatusForbidden, "setup_incomplete")
		return
	}
	if err != nil {
		writeInternal(w)
		return
	}
	if !ok {
		if err := h.lockout.RecordFailure(ctx, userID); err != nil {
			writeInternal(w)
			return
		}
		writeError(w, http.StatusUnauthorized, "invalid_code")
		return
	}
	if err := h.lockout.Reset(ctx, userID); err != nil {
		writeInternal(w)
		return
	}
	h.startSession(w, r, userID, deviceName(r, req.DeviceName), nil)
}

var errSetupIncomplete = errors.New("totp is not set up")

// checkSecondFactor checks a TOTP code or, if code is empty, a recovery
// code. A match is stored (last TOTP step or used_at) in the same
// transaction, so the same code never works two times.
func (h *Handlers) checkSecondFactor(ctx context.Context, userID, code, recoveryCode string) (bool, error) {
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		sealed   []byte
		enabled  bool
		lastStep int64
	)
	err = tx.QueryRow(ctx,
		`SELECT totp_secret_enc, totp_enabled, COALESCE(totp_last_step, 0)
		 FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&sealed, &enabled, &lastStep)
	if err != nil {
		return false, err
	}
	if !enabled || sealed == nil {
		return false, errSetupIncomplete
	}

	if code != "" {
		secret, err := Open(h.totpKey, sealed, userID)
		if err != nil {
			return false, err
		}
		step, ok := Verify(string(secret), code, h.now(), lastStep)
		if !ok {
			return false, nil
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET totp_last_step = $2 WHERE id = $1`, userID, step); err != nil {
			return false, err
		}
	} else {
		tag, err := tx.Exec(ctx,
			`UPDATE recovery_codes SET used_at = $3
			 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
			userID, HashRecoveryCode(recoveryCode), h.now())
		if err != nil {
			return false, err
		}
		if tag.RowsAffected() == 0 {
			return false, nil
		}
	}
	return true, tx.Commit(ctx)
}

type tokenResponse struct {
	AccessToken   string   `json:"access_token"`
	ExpiresIn     int      `json:"expires_in"`
	UserID        string   `json:"user_id"`
	SessionID     string   `json:"session_id"`
	RefreshToken  string   `json:"refresh_token,omitempty"`
	RecoveryCodes []string `json:"recovery_codes,omitempty"`
}

// startSession creates a refresh token for a new session and writes the
// token response.
func (h *Handlers) startSession(w http.ResponseWriter, r *http.Request, userID, device string, recoveryCodes []string) {
	rt, err := h.refresh.Create(r.Context(), userID, device)
	if err != nil {
		writeInternal(w)
		return
	}
	h.writeTokens(w, r, rt, recoveryCodes)
}

// writeTokens sends the refresh token in the body for native clients and in
// the mt_refresh cookie for the web.
func (h *Handlers) writeTokens(w http.ResponseWriter, r *http.Request, rt RefreshToken, recoveryCodes []string) {
	access, err := h.tokens.IssueAccessToken(rt.UserID, h.now())
	if err != nil {
		writeInternal(w)
		return
	}
	resp := tokenResponse{
		AccessToken:   access,
		ExpiresIn:     int(AccessTokenTTL.Seconds()),
		UserID:        rt.UserID,
		SessionID:     rt.SessionID,
		RecoveryCodes: recoveryCodes,
	}
	if isNative(r) {
		resp.RefreshToken = rt.Token
	} else {
		h.setRefreshCookie(w, rt.Token, int(RefreshTokenTTL.Seconds()))
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) refreshToken(w http.ResponseWriter, r *http.Request) {
	if !isNative(r) && r.Header.Get(csrfHeader) != csrfHeaderValue {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	token, ok := h.requestRefreshToken(w, r)
	if !ok {
		return
	}
	rt, err := h.refresh.Rotate(r.Context(), token)
	if errors.Is(err, ErrTokenInvalid) || errors.Is(err, ErrTokenExpired) ||
		errors.Is(err, ErrTokenReused) || errors.Is(err, ErrTokenRevoked) {
		if !isNative(r) {
			h.setRefreshCookie(w, "", -1)
		}
		// The client deletes its local data only for session_revoked.
		code := "refresh_invalid"
		if errors.Is(err, ErrTokenRevoked) {
			code = "session_revoked"
		}
		writeError(w, http.StatusUnauthorized, code)
		return
	}
	if err != nil {
		writeInternal(w)
		return
	}
	h.writeTokens(w, r, rt, nil)
}

func (h *Handlers) logout(w http.ResponseWriter, r *http.Request) {
	if !isNative(r) && r.Header.Get(csrfHeader) != csrfHeaderValue {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	token, ok := h.requestRefreshToken(w, r)
	if !ok {
		return
	}
	if token != "" {
		if err := h.refresh.Revoke(r.Context(), token); err != nil {
			writeInternal(w)
			return
		}
	}
	if !isNative(r) {
		h.setRefreshCookie(w, "", -1)
	}
	w.WriteHeader(http.StatusNoContent)
}

// requestRefreshToken returns the refresh token from the JSON body (native)
// or from the cookie (web). A missing token gives "".
func (h *Handlers) requestRefreshToken(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !isNative(r) {
		c, err := r.Cookie(RefreshCookieName)
		if err != nil {
			return "", true
		}
		return c.Value, true
	}
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if r.ContentLength == 0 {
		return "", true
	}
	if !decode(w, r, &req) {
		return "", false
	}
	return req.RefreshToken, true
}

type sessionJSON struct {
	ID         string    `json:"id"`
	DeviceName string    `json:"device_name"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"`
	Current    bool      `json:"current"`
}

func (h *Handlers) listSessions(w http.ResponseWriter, r *http.Request) {
	userID := UserID(r.Context())
	ctx := r.Context()
	// On the web the cookie names the current session. Native clients
	// know their session ID from the token response.
	var current string
	if c, err := r.Cookie(RefreshCookieName); err == nil {
		_ = h.pool.QueryRow(ctx,
			`SELECT family_id::text FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2`,
			hashRefreshToken(c.Value), userID).Scan(&current)
	}
	sessions, err := h.refresh.ListSessions(ctx, userID, current)
	if err != nil {
		writeInternal(w)
		return
	}
	out := make([]sessionJSON, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, sessionJSON{
			ID:         s.ID,
			DeviceName: s.DeviceName,
			CreatedAt:  s.CreatedAt,
			LastUsedAt: s.LastUsedAt,
			Current:    s.Current,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (h *Handlers) revokeSession(w http.ResponseWriter, r *http.Request) {
	userID := UserID(r.Context())
	err := h.refresh.RevokeSession(r.Context(), userID, r.PathValue("id"))
	if errors.Is(err, ErrSessionNotFound) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		writeInternal(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) setRefreshCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     RefreshCookieName,
		Value:    value,
		Path:     refreshCookiePath,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}

func isNative(r *http.Request) bool {
	return r.Header.Get(nativeClientHeader) == "native"
}

// deviceName takes the name from the body, else from the X-Device-Name header.
func deviceName(r *http.Request, fromBody string) string {
	name := strings.TrimSpace(fromBody)
	if name == "" {
		name = strings.TrimSpace(r.Header.Get(deviceNameHeader))
	}
	if name == "" {
		return "Unknown device"
	}
	if runes := []rune(name); len(runes) > maxDeviceNameRunes {
		name = string(runes[:maxDeviceNameRunes])
	}
	return name
}

func writeInviteError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, users.ErrInviteInvalid):
		writeError(w, http.StatusBadRequest, "invite_invalid")
	case errors.Is(err, users.ErrInviteExpired):
		writeError(w, http.StatusBadRequest, "invite_expired")
	case errors.Is(err, users.ErrInviteUsed):
		writeError(w, http.StatusBadRequest, "invite_used")
	default:
		writeInternal(w)
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func writeInternal(w http.ResponseWriter) {
	writeError(w, http.StatusInternalServerError, "internal")
}
