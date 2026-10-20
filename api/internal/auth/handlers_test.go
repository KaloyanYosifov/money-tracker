package auth_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/config"
	"github.com/KaloyanYosifov/money-tracker/api/internal/httpserver"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

const testPassword = "correct horse battery"

type authEnv struct {
	t       *testing.T
	pool    *pgxpool.Pool
	handler http.Handler
	tokens  *auth.Tokens
	totpKey []byte
	users   *users.Store
	now     *time.Time
	nextIP  int
}

func newAuthEnv(t *testing.T, cookieSecure bool) *authEnv {
	t.Helper()
	return newAuthEnvWith(t, auth.Deps{CookieSecure: cookieSecure})
}

// newAuthEnvWith fills the pool, keys, clock and client IP of deps.
func newAuthEnvWith(t *testing.T, deps auth.Deps) *authEnv {
	t.Helper()
	pool := testutil.StartPostgres(t)
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	totpKey := make([]byte, 32)
	if _, err := rand.Read(totpKey); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	env := &authEnv{
		t:       t,
		pool:    pool,
		tokens:  auth.NewTokens(key, "https://money.example.com"),
		totpKey: totpKey,
		users:   users.NewStore(pool),
		now:     &now,
	}
	env.users.Now = func() time.Time { return *env.now }
	deps.Pool = pool
	deps.Tokens = env.tokens
	deps.TOTPKey = totpKey
	deps.ClientIP = func(r *http.Request) netip.Addr { return httpserver.ClientIP(r, nil) }
	deps.Now = func() time.Time { return *env.now }
	h := auth.NewHandlers(deps)
	mux := http.NewServeMux()
	h.Register(mux)
	env.handler = mux
	return env
}

func (e *authEnv) advance(d time.Duration) { *e.now = e.now.Add(d) }

// request builds a request with a JSON body. Each request gets its own
// client IP, so that only TestRateLimitedRoutes meets the IP limit.
func (e *authEnv) request(method, path string, body any, headers ...string) *http.Request {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	e.nextIP++
	req.RemoteAddr = fmt.Sprintf("10.0.%d.%d:1234", e.nextIP/250, e.nextIP%250+1)
	return req
}

func (e *authEnv) serve(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func (e *authEnv) do(method, path string, body any, headers ...string) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.serve(e.request(method, path, body, headers...))
}

func (e *authEnv) invite(email string) string {
	e.t.Helper()
	token, err := e.users.CreateInvite(context.Background(), email, "EUR", "user")
	if err != nil {
		e.t.Fatalf("CreateInvite: %v", err)
	}
	return token
}

func (e *authEnv) code(secret string) string {
	e.t.Helper()
	code, err := totp.GenerateCode(secret, *e.now)
	if err != nil {
		e.t.Fatal(err)
	}
	return code
}

type registered struct {
	userID   string
	secret   string
	recovery []string
	confirm  *httptest.ResponseRecorder
}

// register accepts and confirms an invite. headers go to the confirm call.
func (e *authEnv) register(email string, headers ...string) registered {
	e.t.Helper()
	token := e.invite(email)
	rec := e.do("POST", "/api/auth/invite/accept", map[string]string{"token": token, "password": testPassword})
	if rec.Code != http.StatusOK {
		e.t.Fatalf("accept: %d %s", rec.Code, rec.Body)
	}
	secret := decodeBody[acceptBody](e.t, rec).Secret
	rec = e.do("POST", "/api/auth/invite/confirm",
		map[string]string{"token": token, "code": e.code(secret), "device_name": "Test device"}, headers...)
	if rec.Code != http.StatusOK {
		e.t.Fatalf("confirm: %d %s", rec.Code, rec.Body)
	}
	body := decodeBody[tokenBody](e.t, rec)
	return registered{userID: body.UserID, secret: secret, recovery: body.RecoveryCodes, confirm: rec}
}

// login runs both login steps with a fresh TOTP code and returns the response.
func (e *authEnv) login(email, secret string, headers ...string) *httptest.ResponseRecorder {
	e.t.Helper()
	e.advance(30 * time.Second)
	mfa := e.mfaToken(email)
	return e.do("POST", "/api/auth/login/totp",
		map[string]string{"mfa_token": mfa, "code": e.code(secret), "device_name": "Second device"}, headers...)
}

func (e *authEnv) mfaToken(email string) string {
	e.t.Helper()
	rec := e.do("POST", "/api/auth/login", map[string]string{"email": email, "password": testPassword})
	if rec.Code != http.StatusOK {
		e.t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	return decodeBody[map[string]string](e.t, rec)["mfa_token"]
}

type acceptBody struct {
	OTPAuthURL   string `json:"otpauth_url"`
	Secret       string `json:"secret"`
	TOTPRequired bool   `json:"totp_required"`
}

type tokenBody struct {
	AccessToken   string   `json:"access_token"`
	ExpiresIn     int      `json:"expires_in"`
	UserID        string   `json:"user_id"`
	SessionID     string   `json:"session_id"`
	RefreshToken  *string  `json:"refresh_token"`
	RecoveryCodes []string `json:"recovery_codes"`
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body, err)
	}
	return v
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body)
	}
	if got := decodeBody[map[string]string](t, rec)["error"]; got != code {
		t.Fatalf("error = %q, want %q", got, code)
	}
}

func refreshCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.RefreshCookieName {
			return c
		}
	}
	return nil
}

func TestInviteAccept(t *testing.T) {
	ctx := context.Background()
	env := newAuthEnv(t, true)
	token := env.invite("new@example.com")

	rec := env.do("POST", "/api/auth/invite/accept", map[string]string{"token": token, "password": testPassword})
	if rec.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", rec.Code, rec.Body)
	}
	body := decodeBody[acceptBody](t, rec)
	if body.Secret == "" || !strings.HasPrefix(body.OTPAuthURL, "otpauth://totp/") || !body.TOTPRequired {
		t.Fatalf("body = %+v, want secret, otpauth_url and totp_required", body)
	}

	readUser := func() (id, hash string, sealed []byte, enabled bool) {
		t.Helper()
		err := env.pool.QueryRow(ctx,
			`SELECT id::text, password_hash, totp_secret_enc, totp_enabled FROM users WHERE email = $1`,
			"new@example.com").Scan(&id, &hash, &sealed, &enabled)
		if err != nil {
			t.Fatalf("read user: %v", err)
		}
		return id, hash, sealed, enabled
	}
	id, hash, sealed, enabled := readUser()
	if !auth.VerifyPassword(testPassword, hash) {
		t.Fatal("stored hash does not match the password")
	}
	if enabled {
		t.Fatal("totp_enabled is true before the confirm step")
	}
	if bytes.Contains(sealed, []byte(body.Secret)) {
		t.Fatal("the TOTP secret is stored in plain text")
	}
	plain, err := auth.Open(env.totpKey, sealed, id)
	if err != nil || string(plain) != body.Secret {
		t.Fatalf("Open = %q, %v; want the returned secret", plain, err)
	}
	if _, err := env.users.CheckInvite(ctx, token); err != nil {
		t.Fatalf("invite is not usable after accept: %v", err)
	}

	rec = env.do("POST", "/api/auth/invite/accept", map[string]string{"token": token, "password": testPassword})
	if rec.Code != http.StatusOK {
		t.Fatalf("second accept: %d %s", rec.Code, rec.Body)
	}
	second := decodeBody[acceptBody](t, rec).Secret
	if second == body.Secret {
		t.Fatal("second accept returned the same secret")
	}
	id2, _, sealed, _ := readUser()
	if id2 != id {
		t.Fatalf("second accept changed the user ID from %s to %s", id, id2)
	}
	if plain, _ := auth.Open(env.totpKey, sealed, id); string(plain) != second {
		t.Fatal("second accept did not replace the pending secret")
	}

	rec = env.do("POST", "/api/auth/invite/accept", map[string]string{"token": token, "password": "short"})
	wantError(t, rec, http.StatusBadRequest, "password_too_short")
	rec = env.do("POST", "/api/auth/invite/accept", map[string]string{"token": "nope", "password": testPassword})
	wantError(t, rec, http.StatusBadRequest, "invite_invalid")
}

func TestInviteConfirm(t *testing.T) {
	ctx := context.Background()
	env := newAuthEnv(t, true)
	token := env.invite("new@example.com")
	rec := env.do("POST", "/api/auth/invite/accept", map[string]string{"token": token, "password": testPassword})
	secret := decodeBody[acceptBody](t, rec).Secret

	wrong := "000000"
	if env.code(secret) == wrong {
		wrong = "111111"
	}
	rec = env.do("POST", "/api/auth/invite/confirm", map[string]string{"token": token, "code": wrong})
	wantError(t, rec, http.StatusBadRequest, "invalid_code")
	if _, err := env.users.CheckInvite(ctx, token); err != nil {
		t.Fatalf("a wrong code used the invite: %v", err)
	}

	rec = env.do("POST", "/api/auth/invite/confirm",
		map[string]string{"token": token, "code": env.code(secret), "device_name": "iPhone"},
		"X-Client", "native")
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", rec.Code, rec.Body)
	}
	body := decodeBody[tokenBody](t, rec)
	if body.AccessToken == "" || body.RefreshToken == nil || body.UserID == "" {
		t.Fatalf("token response is missing fields: %+v", body)
	}
	if len(body.RecoveryCodes) != 10 {
		t.Fatalf("got %d recovery codes, want 10", len(body.RecoveryCodes))
	}

	var enabled bool
	var codes, settings int
	err := env.pool.QueryRow(ctx,
		`SELECT u.totp_enabled,
		        (SELECT count(*) FROM recovery_codes WHERE user_id = u.id),
		        (SELECT count(*) FROM user_settings WHERE user_id = u.id)
		 FROM users u WHERE u.id = $1`, body.UserID).Scan(&enabled, &codes, &settings)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled || codes != 10 || settings != 1 {
		t.Fatalf("totp_enabled=%v recovery_codes=%d user_settings=%d, want true 10 1", enabled, codes, settings)
	}
	if _, err := env.users.CheckInvite(ctx, token); !errors.Is(err, users.ErrInviteUsed) {
		t.Fatalf("CheckInvite after confirm: %v, want ErrInviteUsed", err)
	}

	env.advance(30 * time.Second)
	rec = env.do("POST", "/api/auth/invite/confirm", map[string]string{"token": token, "code": env.code(secret)})
	wantError(t, rec, http.StatusBadRequest, "invite_used")
}

func TestLoginStepOne(t *testing.T) {
	ctx := context.Background()
	env := newAuthEnv(t, true)
	env.register("a@example.com")

	rec := env.do("POST", "/api/auth/login", map[string]string{"email": "A@example.com", "password": testPassword})
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	mfa := decodeBody[map[string]string](t, rec)["mfa_token"]
	if _, err := env.tokens.ParseMFAToken(mfa, *env.now); err != nil {
		t.Fatalf("mfa_token: %v", err)
	}
	if _, err := env.tokens.ParseAccessToken(mfa, *env.now); err == nil {
		t.Fatal("the mfa_token works as an access token")
	}

	wrong := env.do("POST", "/api/auth/login", map[string]string{"email": "a@example.com", "password": "wrong password!"})
	unknown := env.do("POST", "/api/auth/login", map[string]string{"email": "nobody@example.com", "password": "wrong password!"})
	wantError(t, wrong, http.StatusUnauthorized, "invalid_credentials")
	wantError(t, unknown, http.StatusUnauthorized, "invalid_credentials")
	if wrong.Body.String() != unknown.Body.String() {
		t.Fatalf("wrong password and unknown email differ: %q vs %q", wrong.Body, unknown.Body)
	}

	token := env.invite("half@example.com")
	env.do("POST", "/api/auth/invite/accept", map[string]string{"token": token, "password": testPassword})
	rec = env.do("POST", "/api/auth/login", map[string]string{"email": "half@example.com", "password": testPassword})
	wantError(t, rec, http.StatusForbidden, "setup_incomplete")

	for range auth.MaxFailedLogins - 1 {
		env.do("POST", "/api/auth/login", map[string]string{"email": "a@example.com", "password": "wrong password!"})
	}
	rec = env.do("POST", "/api/auth/login", map[string]string{"email": "a@example.com", "password": testPassword})
	wantError(t, rec, http.StatusTooManyRequests, "locked")

	var lockedUntil *time.Time
	if err := env.pool.QueryRow(ctx, `SELECT locked_until FROM users WHERE email = 'a@example.com'`).
		Scan(&lockedUntil); err != nil || lockedUntil == nil {
		t.Fatalf("locked_until = %v, %v; want a time", lockedUntil, err)
	}
}

func TestLoginStepTwo(t *testing.T) {
	env := newAuthEnv(t, true)
	u := env.register("a@example.com")

	env.advance(30 * time.Second)
	code := env.code(u.secret)
	rec := env.do("POST", "/api/auth/login/totp",
		map[string]string{"mfa_token": env.mfaToken("a@example.com"), "code": code}, "X-Client", "native")
	if rec.Code != http.StatusOK {
		t.Fatalf("totp login: %d %s", rec.Code, rec.Body)
	}
	if body := decodeBody[tokenBody](t, rec); body.UserID != u.userID || body.AccessToken == "" {
		t.Fatalf("token response = %+v", body)
	}

	rec = env.do("POST", "/api/auth/login/totp",
		map[string]string{"mfa_token": env.mfaToken("a@example.com"), "code": code})
	wantError(t, rec, http.StatusUnauthorized, "invalid_code")

	rec = env.do("POST", "/api/auth/login/totp",
		map[string]string{"mfa_token": env.mfaToken("a@example.com"), "recovery_code": u.recovery[0]})
	if rec.Code != http.StatusOK {
		t.Fatalf("recovery code login: %d %s", rec.Code, rec.Body)
	}
	rec = env.do("POST", "/api/auth/login/totp",
		map[string]string{"mfa_token": env.mfaToken("a@example.com"), "recovery_code": u.recovery[0]})
	wantError(t, rec, http.StatusUnauthorized, "invalid_code")
	rec = env.do("POST", "/api/auth/login/totp",
		map[string]string{"mfa_token": env.mfaToken("a@example.com"), "recovery_code": strings.ToUpper(u.recovery[1])})
	if rec.Code != http.StatusOK {
		t.Fatalf("fresh recovery code login: %d %s", rec.Code, rec.Body)
	}

	rec = env.do("POST", "/api/auth/login/totp", map[string]string{"mfa_token": "garbage", "code": code})
	wantError(t, rec, http.StatusUnauthorized, "mfa_invalid")
}

func TestTokenResponseNative(t *testing.T) {
	env := newAuthEnv(t, true)
	u := env.register("a@example.com", "X-Client", "native")

	for name, rec := range map[string]*httptest.ResponseRecorder{
		"confirm": u.confirm,
		"login":   env.login("a@example.com", u.secret, "X-Client", "native"),
	} {
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", name, rec.Code, rec.Body)
		}
		body := decodeBody[tokenBody](t, rec)
		if body.AccessToken == "" || body.UserID != u.userID || body.RefreshToken == nil || *body.RefreshToken == "" {
			t.Fatalf("%s: body = %+v", name, body)
		}
		if body.ExpiresIn != int(auth.AccessTokenTTL.Seconds()) {
			t.Fatalf("%s: expires_in = %d", name, body.ExpiresIn)
		}
		if got, err := env.tokens.ParseAccessToken(body.AccessToken, *env.now); err != nil || got != u.userID {
			t.Fatalf("%s: access token = %q, %v", name, got, err)
		}
		if c := refreshCookie(t, rec); c != nil {
			t.Fatalf("%s: native response sets cookie %v", name, c)
		}
	}
}

func TestTokenResponseWeb(t *testing.T) {
	for _, secure := range []bool{true, false} {
		t.Run(fmt.Sprintf("secure=%v", secure), func(t *testing.T) {
			env := newAuthEnv(t, secure)
			u := env.register("a@example.com")
			body := decodeBody[tokenBody](t, u.confirm)
			if body.RefreshToken != nil {
				t.Fatal("web body has refresh_token")
			}
			if body.AccessToken == "" || body.UserID != u.userID {
				t.Fatalf("body = %+v", body)
			}
			c := refreshCookie(t, u.confirm)
			if c == nil || c.Value == "" {
				t.Fatal("no mt_refresh cookie")
			}
			if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/api/auth" ||
				c.MaxAge != 90*24*60*60 || c.Secure != secure {
				t.Fatalf("cookie = %+v", c)
			}
		})
	}
}

func TestRefresh(t *testing.T) {
	t.Run("native", func(t *testing.T) {
		env := newAuthEnv(t, true)
		u := env.register("a@example.com", "X-Client", "native")
		first := *decodeBody[tokenBody](t, u.confirm).RefreshToken

		rec := env.do("POST", "/api/auth/refresh", map[string]string{"refresh_token": first}, "X-Client", "native")
		if rec.Code != http.StatusOK {
			t.Fatalf("refresh: %d %s", rec.Code, rec.Body)
		}
		body := decodeBody[tokenBody](t, rec)
		if body.RefreshToken == nil || *body.RefreshToken == first || body.UserID != u.userID {
			t.Fatalf("refresh body = %+v", body)
		}
		second := *body.RefreshToken

		rec = env.do("POST", "/api/auth/refresh", map[string]string{"refresh_token": first}, "X-Client", "native")
		wantError(t, rec, http.StatusUnauthorized, "refresh_invalid")
		rec = env.do("POST", "/api/auth/refresh", map[string]string{"refresh_token": second}, "X-Client", "native")
		wantError(t, rec, http.StatusUnauthorized, "refresh_invalid")
		rec = env.do("POST", "/api/auth/refresh", map[string]string{"refresh_token": "unknown"}, "X-Client", "native")
		wantError(t, rec, http.StatusUnauthorized, "refresh_invalid")
	})

	t.Run("web", func(t *testing.T) {
		env := newAuthEnv(t, true)
		u := env.register("a@example.com")
		first := refreshCookie(t, u.confirm)

		req := env.request("POST", "/api/auth/refresh", nil)
		req.AddCookie(first)
		wantError(t, env.serve(req), http.StatusForbidden, "forbidden")

		req = env.request("POST", "/api/auth/refresh", nil, "X-Requested-With", "money-tracker")
		req.AddCookie(first)
		rec := env.serve(req)
		if rec.Code != http.StatusOK {
			t.Fatalf("refresh: %d %s", rec.Code, rec.Body)
		}
		if decodeBody[tokenBody](t, rec).RefreshToken != nil {
			t.Fatal("web refresh body has refresh_token")
		}
		second := refreshCookie(t, rec)
		if second == nil || second.Value == first.Value {
			t.Fatalf("refresh did not rotate the cookie: %v", second)
		}

		req = env.request("POST", "/api/auth/refresh", nil, "X-Requested-With", "money-tracker")
		req.AddCookie(first)
		rec = env.serve(req)
		wantError(t, rec, http.StatusUnauthorized, "refresh_invalid")
		if c := refreshCookie(t, rec); c == nil || c.MaxAge >= 0 {
			t.Fatalf("reuse did not clear the cookie: %v", c)
		}

		req = env.request("POST", "/api/auth/refresh", nil, "X-Requested-With", "money-tracker")
		req.AddCookie(second)
		wantError(t, env.serve(req), http.StatusUnauthorized, "refresh_invalid")

		rec = env.do("POST", "/api/auth/refresh", nil, "X-Requested-With", "money-tracker")
		wantError(t, rec, http.StatusUnauthorized, "refresh_invalid")
	})
}

func TestLogout(t *testing.T) {
	t.Run("native", func(t *testing.T) {
		env := newAuthEnv(t, true)
		u := env.register("a@example.com", "X-Client", "native")
		token := *decodeBody[tokenBody](t, u.confirm).RefreshToken

		rec := env.do("POST", "/api/auth/logout", map[string]string{"refresh_token": token}, "X-Client", "native")
		if rec.Code != http.StatusNoContent {
			t.Fatalf("logout: %d %s", rec.Code, rec.Body)
		}
		rec = env.do("POST", "/api/auth/refresh", map[string]string{"refresh_token": token}, "X-Client", "native")
		wantError(t, rec, http.StatusUnauthorized, "refresh_invalid")
	})

	t.Run("web", func(t *testing.T) {
		env := newAuthEnv(t, true)
		u := env.register("a@example.com")
		cookie := refreshCookie(t, u.confirm)

		req := env.request("POST", "/api/auth/logout", nil, "X-Requested-With", "money-tracker")
		req.AddCookie(cookie)
		rec := env.serve(req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("logout: %d %s", rec.Code, rec.Body)
		}
		if c := refreshCookie(t, rec); c == nil || c.MaxAge >= 0 || c.Value != "" {
			t.Fatalf("logout did not clear the cookie: %v", c)
		}

		req = env.request("POST", "/api/auth/refresh", nil, "X-Requested-With", "money-tracker")
		req.AddCookie(cookie)
		wantError(t, env.serve(req), http.StatusUnauthorized, "refresh_invalid")
	})
}

func TestSessions(t *testing.T) {
	env := newAuthEnv(t, true)
	a := env.register("a@example.com")
	webSession := decodeBody[tokenBody](t, a.confirm)
	webCookie := refreshCookie(t, a.confirm)
	native := decodeBody[tokenBody](t, env.login("a@example.com", a.secret, "X-Client", "native"))
	b := env.register("b@example.com", "X-Client", "native")
	bSession := decodeBody[tokenBody](t, b.confirm)

	rec := env.do("GET", "/api/auth/sessions", nil)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized")
	if rec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q", rec.Header().Get("WWW-Authenticate"))
	}

	type sessionsBody struct {
		Sessions []struct {
			ID         string `json:"id"`
			DeviceName string `json:"device_name"`
			Current    bool   `json:"current"`
		} `json:"sessions"`
	}
	list := func() sessionsBody {
		t.Helper()
		req := env.request("GET", "/api/auth/sessions", nil, "Authorization", "Bearer "+native.AccessToken)
		req.AddCookie(webCookie)
		rec := env.serve(req)
		if rec.Code != http.StatusOK {
			t.Fatalf("sessions: %d %s", rec.Code, rec.Body)
		}
		return decodeBody[sessionsBody](t, rec)
	}

	got := list()
	if len(got.Sessions) != 2 {
		t.Fatalf("got %d sessions, want 2: %+v", len(got.Sessions), got)
	}
	for _, s := range got.Sessions {
		if s.Current != (s.ID == webSession.SessionID) {
			t.Fatalf("session %s current = %v, cookie session is %s", s.ID, s.Current, webSession.SessionID)
		}
	}

	rec = env.do("DELETE", "/api/auth/sessions/"+bSession.SessionID, nil, "Authorization", "Bearer "+native.AccessToken)
	wantError(t, rec, http.StatusNotFound, "not_found")

	rec = env.do("DELETE", "/api/auth/sessions/"+webSession.SessionID, nil, "Authorization", "Bearer "+native.AccessToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body)
	}
	got = list()
	if len(got.Sessions) != 1 || got.Sessions[0].ID != native.SessionID {
		t.Fatalf("sessions after revoke = %+v, want only %s", got, native.SessionID)
	}

	rec = env.do("GET", "/api/auth/sessions", nil, "Authorization", "Bearer "+bSession.AccessToken)
	if n := len(decodeBody[sessionsBody](t, rec).Sessions); n != 1 {
		t.Fatalf("user b has %d sessions, want 1", n)
	}
}

func TestJWKSRoute(t *testing.T) {
	pool := testutil.StartPostgres(t)
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		ListenAddr:    ":0",
		JWTPrivateKey: key,
		JWTIssuer:     "https://money.example.com",
		TOTPEncKey:    make([]byte, 32),
	}
	handler := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), pool).Handler

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/api/.well-known/jwks.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	if want := auth.NewTokens(key, cfg.JWTIssuer).JWKS(); !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatalf("body = %s, want %s", rec.Body, want)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("POST", "/api/auth/login", strings.NewReader("{}")))
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("login Cache-Control = %q, want no-store", got)
	}
}

func TestRateLimitedRoutes(t *testing.T) {
	env := newAuthEnv(t, true)
	fromIP := func(ip, path string) *httptest.ResponseRecorder {
		req := env.request("POST", path, map[string]string{}, "X-Client", "native")
		req.RemoteAddr = ip + ":1234"
		return env.serve(req)
	}

	for i := range auth.LoginAttemptsPerMinute {
		if rec := fromIP("192.0.2.1", "/api/auth/login"); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d was limited", i+1)
		}
	}
	for _, path := range []string{"/api/auth/login", "/api/auth/login/totp", "/api/auth/refresh"} {
		wantError(t, fromIP("192.0.2.1", path), http.StatusTooManyRequests, "rate_limited")
	}
	if rec := fromIP("192.0.2.2", "/api/auth/login"); rec.Code == http.StatusTooManyRequests {
		t.Fatal("another IP was limited")
	}

	env.advance(time.Minute)
	if rec := fromIP("192.0.2.1", "/api/auth/refresh"); rec.Code == http.StatusTooManyRequests {
		t.Fatal("the IP is still limited after one minute")
	}
}

func TestTOTPDisabled(t *testing.T) {
	env := newAuthEnvWith(t, auth.Deps{TOTPDisabled: true})
	token := env.invite("nototp@example.com")

	rec := env.do("POST", "/api/auth/invite/accept", map[string]string{"token": token, "password": testPassword})
	if rec.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", rec.Code, rec.Body)
	}
	if decodeBody[acceptBody](t, rec).TOTPRequired {
		t.Fatal("totp_required = true, want false")
	}
	rec = env.do("POST", "/api/auth/invite/confirm", map[string]string{"token": token, "code": ""})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm without a code: %d %s", rec.Code, rec.Body)
	}
	if body := decodeBody[tokenBody](t, rec); body.AccessToken == "" || len(body.RecoveryCodes) == 0 {
		t.Fatalf("confirm body = %+v, want tokens and recovery codes", body)
	}

	rec = env.do("POST", "/api/auth/login", map[string]string{"email": "nototp@example.com", "password": testPassword})
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	if body := decodeBody[tokenBody](t, rec); body.AccessToken == "" {
		t.Fatalf("login body = %+v, want an access token without the TOTP step", body)
	}
	rec = env.do("POST", "/api/auth/login", map[string]string{"email": "nototp@example.com", "password": "wrong password"})
	wantError(t, rec, http.StatusUnauthorized, "invalid_credentials")
}
