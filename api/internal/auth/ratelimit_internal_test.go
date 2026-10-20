package auth

import (
	"net/netip"
	"testing"
)

func TestLimiterKey(t *testing.T) {
	for _, tc := range []struct{ ip, want string }{
		{"192.0.2.1", "192.0.2.1"},
		{"2001:db8:0:1::1", "2001:db8:0:1::/64"},
		{"2001:db8:0:1:ffff:ffff:ffff:ffff", "2001:db8:0:1::/64"},
		{"2001:db8:0:2::1", "2001:db8:0:2::/64"},
	} {
		if got := limiterKey(netip.MustParseAddr(tc.ip)); got != tc.want {
			t.Errorf("limiterKey(%s) = %q, want %q", tc.ip, got, tc.want)
		}
	}
}
