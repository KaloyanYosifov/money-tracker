package httpserver

import (
	"log/slog"
	"net/http"
	"net/netip"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/config"
	"github.com/KaloyanYosifov/money-tracker/api/internal/sync"
)

const maxBodyBytes = 1 << 20

// New returns an http.Server with the routes and the middleware.
// The caller calls ListenAndServe and Shutdown.
func New(cfg *config.Config, logger *slog.Logger, pool *pgxpool.Pool) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	authHandlers := auth.NewHandlers(auth.Deps{
		Pool:         pool,
		Tokens:       auth.NewTokens(cfg.JWTPrivateKey, cfg.JWTIssuer),
		TOTPKey:      cfg.TOTPEncKey,
		CookieSecure: cfg.CookieSecure,
		ClientIP:     func(r *http.Request) netip.Addr { return ClientIP(r, cfg.TrustedProxyCIDRs) },
	})
	authHandlers.Register(mux)
	mux.Handle("POST /api/sync/upload", authHandlers.RequireUser(sync.NewUploadHandler(pool, logger)))

	var handler http.Handler = mux
	handler = limitBody(handler)
	handler = cors(cfg.CORSOrigins, handler)
	handler = securityHeaders(handler)
	handler = logRequests(logger, handler)

	return &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "no-store")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// limitBody rejects a declared Content-Length above the limit before routing,
// so that the 413 does not depend on the handler. MaxBytesReader covers
// bodies without a Content-Length.
func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > maxBodyBytes {
			w.Header().Set("Connection", "close")
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		next.ServeHTTP(w, r)
	})
}

func cors(origins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		w.Header().Add("Vary", "Origin")
		if origin == "" || !slices.Contains(origins, origin) {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Credentials", "true")
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// logRequests logs method, path, status and duration. It never logs headers,
// query strings or bodies, because they can carry tokens and codes.
func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}
