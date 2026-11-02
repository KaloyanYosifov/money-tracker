package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"
)

var requiredVars = []string{
	"DATABASE_URL",
	"PUBLIC_URL",
	"JWT_PRIVATE_KEY_PEM",
	"JWT_ISSUER",
	"TOTP_ENC_KEY",
}

func envFunc(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}

func testKeyPEM(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), priv
}

func validEnv(t *testing.T) (map[string]string, ed25519.PrivateKey, []byte) {
	t.Helper()
	keyPEM, priv := testKeyPEM(t)
	totpKey := make([]byte, 32)
	for i := range totpKey {
		totpKey[i] = byte(i)
	}
	return map[string]string{
		"DATABASE_URL":        "postgres://u:p@localhost:5432/money",
		"PUBLIC_URL":          "https://money.example.com",
		"JWT_PRIVATE_KEY_PEM": keyPEM,
		"JWT_ISSUER":          "https://money.example.com",
		"TOTP_ENC_KEY":        base64.StdEncoding.EncodeToString(totpKey),
	}, priv, totpKey
}

func TestLoadRequiresAllSettings(t *testing.T) {
	_, err := Load(envFunc(map[string]string{}))
	if err == nil {
		t.Fatal("expected an error for an empty environment")
	}
	for _, name := range requiredVars {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error %q does not name %s", err, name)
		}
	}
}

func TestLoadParsesValidEnv(t *testing.T) {
	env, priv, totpKey := validEnv(t)
	env["LISTEN_ADDR"] = ":9090"
	env["COOKIE_SECURE"] = "false"
	env["TRUSTED_PROXY_CIDRS"] = "10.42.0.0/16, 127.0.0.1/32"
	env["CORS_ORIGINS"] = "http://localhost:8081, https://money.example.com"

	cfg, err := Load(envFunc(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DatabaseURL != env["DATABASE_URL"] {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.ListenAddr != ":9090" {
		t.Errorf("ListenAddr = %q", cfg.ListenAddr)
	}
	if cfg.PublicURL != env["PUBLIC_URL"] {
		t.Errorf("PublicURL = %q", cfg.PublicURL)
	}
	if !priv.Equal(cfg.JWTPrivateKey) {
		t.Error("JWTPrivateKey does not match the PEM key")
	}
	if cfg.JWTIssuer != env["JWT_ISSUER"] {
		t.Errorf("JWTIssuer = %q", cfg.JWTIssuer)
	}
	if !slices.Equal(cfg.TOTPEncKey, totpKey) {
		t.Errorf("TOTPEncKey = %x", cfg.TOTPEncKey)
	}
	if cfg.CookieSecure {
		t.Error("CookieSecure = true, want false")
	}
	wantCIDRs := []netip.Prefix{netip.MustParsePrefix("10.42.0.0/16"), netip.MustParsePrefix("127.0.0.1/32")}
	if !slices.Equal(cfg.TrustedProxyCIDRs, wantCIDRs) {
		t.Errorf("TrustedProxyCIDRs = %v", cfg.TrustedProxyCIDRs)
	}
	wantOrigins := []string{"http://localhost:8081", "https://money.example.com"}
	if !slices.Equal(cfg.CORSOrigins, wantOrigins) {
		t.Errorf("CORSOrigins = %v", cfg.CORSOrigins)
	}
}

func TestLoadDefaults(t *testing.T) {
	env, _, _ := validEnv(t)
	cfg, err := Load(envFunc(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ListenAddr != ":8080" {
		t.Errorf("ListenAddr = %q, want :8080", cfg.ListenAddr)
	}
	if !cfg.CookieSecure {
		t.Error("CookieSecure = false, want true")
	}
	if len(cfg.TrustedProxyCIDRs) != 0 || len(cfg.CORSOrigins) != 0 {
		t.Errorf("lists not empty: %v %v", cfg.TrustedProxyCIDRs, cfg.CORSOrigins)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	cases := map[string]string{
		"TOTP_ENC_KEY":        base64.StdEncoding.EncodeToString(make([]byte, 16)),
		"JWT_PRIVATE_KEY_PEM": "not a pem",
		"COOKIE_SECURE":       "maybe",
		"TRUSTED_PROXY_CIDRS": "10.0.0.0/99",
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			env, _, _ := validEnv(t)
			env[name] = value
			_, err := Load(envFunc(env))
			if err == nil || !strings.Contains(err.Error(), name) {
				t.Fatalf("err = %v, want an error that names %s", err, name)
			}
		})
	}
}

func TestLoadDisableTOTP(t *testing.T) {
	cases := []struct {
		publicURL string
		value     string
		want      bool
		wantErr   bool
	}{
		{"http://localhost:8088", "true", true, false},
		{"http://127.0.0.1:8088", "true", true, false},
		{"http://[::1]:8088", "true", true, false},
		{"https://money.example.com", "true", false, true},
		{"https://money.example.com", "false", false, false},
		{"http://localhost:8088", "maybe", false, true},
	}
	for _, c := range cases {
		env, _, _ := validEnv(t)
		env["PUBLIC_URL"] = c.publicURL
		env["DISABLE_TOTP"] = c.value
		cfg, err := Load(envFunc(env))
		if c.wantErr {
			if err == nil || !strings.Contains(err.Error(), "DISABLE_TOTP") {
				t.Errorf("%s %s: err = %v, want a DISABLE_TOTP error", c.publicURL, c.value, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s %s: Load: %v", c.publicURL, c.value, err)
		}
		if cfg.TOTPDisabled != c.want {
			t.Errorf("%s %s: TOTPDisabled = %v, want %v", c.publicURL, c.value, cfg.TOTPDisabled, c.want)
		}
	}
}

func TestLoadPricesDefaults(t *testing.T) {
	env, _, _ := validEnv(t)
	cfg, err := Load(envFunc(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.PricesEnabled || cfg.PricesFake {
		t.Errorf("PricesEnabled = %v, PricesFake = %v, want true, false", cfg.PricesEnabled, cfg.PricesFake)
	}
	if cfg.PricesSourceURL != "https://query1.finance.yahoo.com" {
		t.Errorf("PricesSourceURL = %q", cfg.PricesSourceURL)
	}
	if cfg.PricesInterval != 5*time.Minute {
		t.Errorf("PricesInterval = %v, want 5m", cfg.PricesInterval)
	}
}

func TestLoadPricesSettings(t *testing.T) {
	env, _, _ := validEnv(t)
	env["PRICES_ENABLED"] = "false"
	env["PRICES_FAKE"] = "true"
	env["PRICES_SOURCE_URL"] = "http://stub:9000"
	env["PRICES_INTERVAL"] = "2s"
	cfg, err := Load(envFunc(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PricesEnabled || !cfg.PricesFake {
		t.Errorf("PricesEnabled = %v, PricesFake = %v, want false, true", cfg.PricesEnabled, cfg.PricesFake)
	}
	if cfg.PricesSourceURL != "http://stub:9000" {
		t.Errorf("PricesSourceURL = %q", cfg.PricesSourceURL)
	}
	if cfg.PricesInterval != 2*time.Second {
		t.Errorf("PricesInterval = %v, want 2s", cfg.PricesInterval)
	}
}

func TestLoadRejectsInvalidPrices(t *testing.T) {
	cases := []struct{ name, value string }{
		{"PRICES_ENABLED", "maybe"},
		{"PRICES_FAKE", "maybe"},
		{"PRICES_INTERVAL", "abc"},
		{"PRICES_INTERVAL", "0s"},
		{"PRICES_INTERVAL", "-1m"},
		{"PRICES_SOURCE_URL", "not a url"},
		{"PRICES_SOURCE_URL", "/no-host"},
	}
	for _, c := range cases {
		t.Run(c.name+"="+c.value, func(t *testing.T) {
			env, _, _ := validEnv(t)
			env[c.name] = c.value
			_, err := Load(envFunc(env))
			if err == nil || !strings.Contains(err.Error(), c.name) {
				t.Fatalf("err = %v, want an error that names %s", err, c.name)
			}
		})
	}
}
