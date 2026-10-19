package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRequireUser(t *testing.T) {
	tk := newTestTokens(t)
	h := NewHandlers(Deps{Tokens: tk, Now: func() time.Time { return testNow }})

	var gotUser string
	called := false
	protected := h.RequireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		gotUser = UserID(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	access, err := tk.IssueAccessToken("user-1", testNow)
	if err != nil {
		t.Fatal(err)
	}
	expired, err := tk.IssueAccessToken("user-1", testNow.Add(-AccessTokenTTL-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	mfa, err := tk.IssueMFAToken("user-1", testNow)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("valid token", func(t *testing.T) {
		called, gotUser = false, ""
		req := httptest.NewRequest("GET", "/api/x", nil)
		req.Header.Set("Authorization", "Bearer "+access)
		rec := httptest.NewRecorder()
		protected.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent || !called {
			t.Fatalf("status = %d, called = %v", rec.Code, called)
		}
		if gotUser != "user-1" {
			t.Errorf("UserID = %q, want user-1", gotUser)
		}
	})

	cases := map[string]string{
		"no token":      "",
		"not bearer":    "Basic " + access,
		"expired token": "Bearer " + expired,
		"mfa token":     "Bearer " + mfa,
		"garbage":       "Bearer not-a-token",
	}
	for name, header := range cases {
		t.Run(name, func(t *testing.T) {
			called = false
			req := httptest.NewRequest("GET", "/api/x", nil)
			if header != "" {
				req.Header.Set("Authorization", header)
			}
			rec := httptest.NewRecorder()
			protected.ServeHTTP(rec, req)
			if called {
				t.Fatal("next handler was called")
			}
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			if got := rec.Header().Get("WWW-Authenticate"); got != "Bearer" {
				t.Errorf("WWW-Authenticate = %q", got)
			}
			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["error"] != "unauthorized" {
				t.Errorf("error = %q", body["error"])
			}
		})
	}
}

func TestUserIDWithoutUser(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	if got := UserID(req.Context()); got != "" {
		t.Errorf("UserID = %q, want empty", got)
	}
}
