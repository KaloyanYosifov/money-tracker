package config

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

type Config struct {
	DatabaseURL       string
	ListenAddr        string
	PublicURL         string
	JWTPrivateKey     ed25519.PrivateKey
	JWTIssuer         string
	TOTPEncKey        []byte
	CookieSecure      bool
	TrustedProxyCIDRs []netip.Prefix
	CORSOrigins       []string
	// TOTPDisabled skips the TOTP step at login and at invite setup. Only for
	// local tests: Load refuses it unless PUBLIC_URL is a localhost URL.
	TOTPDisabled bool
}

// Load reads the configuration through getenv (os.Getenv in production).
// The returned error names every missing or invalid variable.
func Load(getenv func(string) string) (*Config, error) {
	var errs []error
	required := func(name string) string {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			errs = append(errs, fmt.Errorf("%s is required", name))
		}
		return v
	}

	cfg := &Config{
		DatabaseURL:  required("DATABASE_URL"),
		ListenAddr:   strings.TrimSpace(getenv("LISTEN_ADDR")),
		PublicURL:    required("PUBLIC_URL"),
		JWTIssuer:    required("JWT_ISSUER"),
		CookieSecure: true,
		CORSOrigins:  splitList(getenv("CORS_ORIGINS")),
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = ":8080"
	}

	if v := required("JWT_PRIVATE_KEY_PEM"); v != "" {
		key, err := parseEd25519PEM(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("JWT_PRIVATE_KEY_PEM: %w", err))
		}
		cfg.JWTPrivateKey = key
	}

	if v := required("TOTP_ENC_KEY"); v != "" {
		key, err := base64.StdEncoding.DecodeString(v)
		switch {
		case err != nil:
			errs = append(errs, fmt.Errorf("TOTP_ENC_KEY: not valid base64: %w", err))
		case len(key) != 32:
			errs = append(errs, fmt.Errorf("TOTP_ENC_KEY: must decode to 32 bytes, got %d", len(key)))
		default:
			cfg.TOTPEncKey = key
		}
	}

	if v := strings.TrimSpace(getenv("COOKIE_SECURE")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("COOKIE_SECURE: %w", err))
		}
		cfg.CookieSecure = b
	}

	if v := strings.TrimSpace(getenv("DISABLE_TOTP")); v != "" {
		b, err := strconv.ParseBool(v)
		switch {
		case err != nil:
			errs = append(errs, fmt.Errorf("DISABLE_TOTP: %w", err))
		case b && !isLocalhostURL(cfg.PublicURL):
			errs = append(errs, errors.New("DISABLE_TOTP: allowed only when PUBLIC_URL is a localhost URL"))
		default:
			cfg.TOTPDisabled = b
		}
	}

	for _, s := range splitList(getenv("TRUSTED_PROXY_CIDRS")) {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			errs = append(errs, fmt.Errorf("TRUSTED_PROXY_CIDRS: %w", err))
			continue
		}
		cfg.TrustedProxyCIDRs = append(cfg.TrustedProxyCIDRs, p.Masked())
	}

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return cfg, nil
}

func parseEd25519PEM(s string) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode([]byte(s))
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("not a PKCS#8 key: %w", err)
	}
	ed, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("key type %T is not Ed25519", key)
	}
	return ed, nil
}

func isLocalhostURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil {
		return false
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}
