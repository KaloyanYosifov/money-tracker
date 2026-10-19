package auth

import (
	"context"
	"net/http"
	"strings"
)

type userIDKey struct{}

// RequireUser lets a request through only with a valid access token in the
// Authorization header. It puts the user ID in the request context, so that
// next can read it with UserID. Else it writes 401 unauthorized.
func (h *Handlers) RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if found {
			if userID, err := h.tokens.ParseAccessToken(token, h.now()); err == nil {
				ctx := context.WithValue(r.Context(), userIDKey{}, userID)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized")
	})
}

// UserID returns the user ID that RequireUser put in ctx, or "" if there is none.
func UserID(ctx context.Context) string {
	userID, _ := ctx.Value(userIDKey{}).(string)
	return userID
}
