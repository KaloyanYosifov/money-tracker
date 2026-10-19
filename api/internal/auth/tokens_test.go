package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testIssuer = "https://money.example.com"

var testNow = time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

func newTestTokens(t *testing.T) *Tokens {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return NewTokens(priv, testIssuer)
}

func decodeSegment(t *testing.T, token string, i int) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[i])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func audience(t *testing.T, claims map[string]any) []string {
	t.Helper()
	list, ok := claims["aud"].([]any)
	if !ok {
		t.Fatalf("aud is %T, want a list", claims["aud"])
	}
	var out []string
	for _, v := range list {
		out = append(out, v.(string))
	}
	return out
}

func TestIssueAccessToken(t *testing.T) {
	tk := newTestTokens(t)
	token, err := tk.IssueAccessToken("user-1", testNow)
	if err != nil {
		t.Fatal(err)
	}

	header := decodeSegment(t, token, 0)
	if header["alg"] != "EdDSA" {
		t.Errorf("alg = %v", header["alg"])
	}
	if header["kid"] != tk.KID() || tk.KID() == "" {
		t.Errorf("kid = %v, want %q", header["kid"], tk.KID())
	}

	claims := decodeSegment(t, token, 1)
	if claims["iss"] != testIssuer {
		t.Errorf("iss = %v", claims["iss"])
	}
	if claims["sub"] != "user-1" {
		t.Errorf("sub = %v", claims["sub"])
	}
	if got := audience(t, claims); !slices.Equal(got, []string{"mt-api", "mt-powersync"}) {
		t.Errorf("aud = %v", got)
	}
	if int64(claims["iat"].(float64)) != testNow.Unix() {
		t.Errorf("iat = %v", claims["iat"])
	}
	if int64(claims["exp"].(float64)) != testNow.Add(10*time.Minute).Unix() {
		t.Errorf("exp = %v", claims["exp"])
	}

	sub, err := tk.ParseAccessToken(token, testNow.Add(time.Minute))
	if err != nil || sub != "user-1" {
		t.Errorf("ParseAccessToken = %q, %v", sub, err)
	}
}

func TestIssueMFAToken(t *testing.T) {
	tk := newTestTokens(t)
	token, err := tk.IssueMFAToken("user-1", testNow)
	if err != nil {
		t.Fatal(err)
	}
	claims := decodeSegment(t, token, 1)
	if got := audience(t, claims); !slices.Equal(got, []string{"mt-mfa"}) {
		t.Errorf("aud = %v", got)
	}
	if int64(claims["exp"].(float64)) != testNow.Add(5*time.Minute).Unix() {
		t.Errorf("exp = %v", claims["exp"])
	}

	sub, err := tk.ParseMFAToken(token, testNow.Add(time.Minute))
	if err != nil || sub != "user-1" {
		t.Errorf("ParseMFAToken = %q, %v", sub, err)
	}
}

func TestParseAccessTokenRejects(t *testing.T) {
	tk := newTestTokens(t)
	other := newTestTokens(t)

	signWith := func(method jwt.SigningMethod, key any, claims jwt.MapClaims) string {
		t.Helper()
		tok := jwt.NewWithClaims(method, claims)
		tok.Header["kid"] = tk.KID()
		s, err := tok.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	validClaims := func() jwt.MapClaims {
		return jwt.MapClaims{
			"iss": testIssuer,
			"sub": "user-1",
			"aud": []string{"mt-api", "mt-powersync"},
			"iat": testNow.Unix(),
			"exp": testNow.Add(10 * time.Minute).Unix(),
		}
	}

	wrongSig, err := other.IssueAccessToken("user-1", testNow)
	if err != nil {
		t.Fatal(err)
	}
	expired, err := tk.IssueAccessToken("user-1", testNow.Add(-11*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	wrongAudClaims := validClaims()
	wrongAudClaims["aud"] = []string{"somebody-else"}
	wrongIssClaims := validClaims()
	wrongIssClaims["iss"] = "https://evil.example.com"
	mfa, err := tk.IssueMFAToken("user-1", testNow)
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string]string{
		"wrong signature": wrongSig,
		"expired":         expired,
		"wrong aud":       signWith(jwt.SigningMethodEdDSA, tk.key, wrongAudClaims),
		"wrong iss":       signWith(jwt.SigningMethodEdDSA, tk.key, wrongIssClaims),
		"alg none":        signWith(jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, validClaims()),
		"mfa token":       mfa,
		"garbage":         "not.a.token",
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			if sub, err := tk.ParseAccessToken(token, testNow); err == nil {
				t.Errorf("accepted, sub = %q", sub)
			}
		})
	}
}

func TestJWKS(t *testing.T) {
	tk := newTestTokens(t)
	var doc struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(tk.JWKS(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Keys) != 1 {
		t.Fatalf("got %d keys, want 1", len(doc.Keys))
	}
	k := doc.Keys[0]
	want := map[string]string{"kty": "OKP", "crv": "Ed25519", "kid": tk.KID(), "use": "sig", "alg": "EdDSA"}
	for field, v := range want {
		if k[field] != v {
			t.Errorf("%s = %v, want %q", field, k[field], v)
		}
	}
	if _, ok := k["d"]; ok {
		t.Error("JWKS contains the private part d")
	}
	x, err := base64.RawURLEncoding.DecodeString(k["x"].(string))
	if err != nil {
		t.Fatal(err)
	}
	pub := tk.key.Public().(ed25519.PublicKey)
	if !pub.Equal(ed25519.PublicKey(x)) {
		t.Error("x does not match the public key")
	}
}
