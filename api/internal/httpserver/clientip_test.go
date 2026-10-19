package httpserver

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.42.0.0/16")}

	tests := []struct {
		name       string
		remoteAddr string
		realIP     string
		forwarded  string
		want       string
	}{
		{"no proxy", "203.0.113.5:4000", "", "", "203.0.113.5"},
		{"untrusted remote ignores X-Real-IP", "203.0.113.5:4000", "198.51.100.7", "", "203.0.113.5"},
		{"untrusted remote ignores X-Forwarded-For", "203.0.113.5:4000", "", "198.51.100.7", "203.0.113.5"},
		{"trusted proxy uses X-Real-IP", "10.42.1.9:4000", "198.51.100.7", "192.0.2.1", "198.51.100.7"},
		{"trusted proxy uses last X-Forwarded-For hop", "10.42.1.9:4000", "", "192.0.2.1, 198.51.100.7", "198.51.100.7"},
		{"trusted proxy without headers", "10.42.1.9:4000", "", "", "10.42.1.9"},
		{"trusted proxy with bad header", "10.42.1.9:4000", "not-an-ip", "", "10.42.1.9"},
		{"IPv6 remote", "[2001:db8::1]:4000", "", "", "2001:db8::1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = tt.remoteAddr
			if tt.realIP != "" {
				r.Header.Set("X-Real-IP", tt.realIP)
			}
			if tt.forwarded != "" {
				r.Header.Set("X-Forwarded-For", tt.forwarded)
			}
			if got := ClientIP(r, trusted); got.String() != tt.want {
				t.Fatalf("ClientIP = %s, want %s", got, tt.want)
			}
		})
	}
}
