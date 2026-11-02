package httpserver

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/config"
)

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		ListenAddr:    ":0",
		CORSOrigins:   []string{"http://localhost:8081"},
		JWTPrivateKey: key,
	}
	return New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil).Handler
}

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("body = %q, want ok", rec.Body.String())
	}
}

func TestMetrics(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	want := `mtapi_yahoo_requests_total{endpoint="chart",result="contract_broken"} 0`
	if !strings.Contains(rec.Body.String(), want) {
		t.Errorf("body =\n%s\nwant it to contain %s", rec.Body.String(), want)
	}
}

func TestSecurityHeaders(t *testing.T) {
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "no-store",
		"Referrer-Policy":        "no-referrer",
	}
	h := newTestHandler(t)
	for _, path := range []string{"/healthz", "/does-not-exist"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		for name, value := range want {
			if got := rec.Header().Get(name); got != value {
				t.Errorf("%s: %s = %q, want %q", path, name, got, value)
			}
		}
	}
}

func TestBodyLimit(t *testing.T) {
	body := bytes.Repeat([]byte("a"), 2<<20)
	rec := httptest.NewRecorder()
	newTestHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/anything", bytes.NewReader(body)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestCORS(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "http://localhost:8081")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:8081" {
		t.Errorf("allowed origin: Access-Control-Allow-Origin = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("allowed origin: Access-Control-Allow-Credentials = %q", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	for name := range rec.Header() {
		if len(name) > len("Access-Control-") && name[:len("Access-Control-")] == "Access-Control-" {
			t.Errorf("other origin got CORS header %s", name)
		}
	}
}

func TestInstrumentRoutesNeedToken(t *testing.T) {
	h := newTestHandler(t)
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/instruments/search?q=acme", nil),
		httptest.NewRequest(http.MethodPost, "/api/instruments", bytes.NewReader([]byte(`{"symbol":"ACME"}`))),
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401", req.Method, req.URL.Path, rec.Code)
		}
	}
}
