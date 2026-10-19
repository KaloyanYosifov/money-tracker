package httpserver

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// ClientIP returns the IP of the client. It uses X-Real-IP, or else the last
// X-Forwarded-For hop, only when the remote address is in a trusted proxy
// CIDR. The last hop is the one that the trusted proxy added. Earlier hops
// come from the client and can be forged.
func ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	remote := remoteAddr(r)
	if !remote.IsValid() || !isTrusted(remote, trusted) {
		return remote
	}
	if ip, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP"))); err == nil {
		return ip.Unmap()
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		hops := strings.Split(xff, ",")
		if ip, err := netip.ParseAddr(strings.TrimSpace(hops[len(hops)-1])); err == nil {
			return ip.Unmap()
		}
	}
	return remote
}

func remoteAddr(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return ip.Unmap()
}

func isTrusted(ip netip.Addr, trusted []netip.Prefix) bool {
	for _, p := range trusted {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}
