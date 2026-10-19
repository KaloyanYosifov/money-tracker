package auth

import (
	"encoding/base32"
	"net/url"
	"strings"
	"testing"
	"time"
)

// RFC 6238 test vector: the secret is ASCII "12345678901234567890" and the
// SHA1 code at Unix time 1111111109 is 07081804. The 6-digit code is 081804.
const (
	rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	rfcCode   = "081804"
	rfcUnix   = 1111111109
	rfcStep   = rfcUnix / 30
)

var rfcNow = time.Unix(rfcUnix, 0).UTC()

func TestNewTOTPSecret(t *testing.T) {
	secret, otpURL, err := NewTOTPSecret("ann@example.com")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatalf("secret %q is not base32: %v", secret, err)
	}
	if len(raw) < 20 {
		t.Errorf("secret has %d bytes, want at least 20", len(raw))
	}
	prefix := "otpauth://totp/Money%20Tracker:ann@example.com?"
	if !strings.HasPrefix(otpURL, prefix) {
		t.Fatalf("URL %q does not start with %q", otpURL, prefix)
	}
	if !strings.Contains(otpURL, "issuer=Money%20Tracker") {
		t.Errorf("URL %q has no issuer=Money%%20Tracker", otpURL)
	}
	u, err := url.Parse(otpURL)
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Query().Get("secret"); got != secret {
		t.Errorf("URL secret = %q, want %q", got, secret)
	}
}

func TestVerifyCurrentStep(t *testing.T) {
	step, ok := Verify(rfcSecret, rfcCode, rfcNow, 0)
	if !ok {
		t.Fatal("Verify rejected the current code")
	}
	if step != rfcStep {
		t.Errorf("step = %d, want %d", step, rfcStep)
	}
}

func TestVerifyAcceptsOneStepDrift(t *testing.T) {
	for _, d := range []time.Duration{-30 * time.Second, 30 * time.Second} {
		step, ok := Verify(rfcSecret, rfcCode, rfcNow.Add(d), 0)
		if !ok {
			t.Errorf("drift %v: Verify rejected the code", d)
			continue
		}
		if step != rfcStep {
			t.Errorf("drift %v: step = %d, want %d", d, step, rfcStep)
		}
	}
}

func TestVerifyRejectsTwoStepsDrift(t *testing.T) {
	for _, d := range []time.Duration{-60 * time.Second, 60 * time.Second} {
		if _, ok := Verify(rfcSecret, rfcCode, rfcNow.Add(d), 0); ok {
			t.Errorf("drift %v: Verify accepted the code", d)
		}
	}
}

func TestVerifyRejectsReplay(t *testing.T) {
	if _, ok := Verify(rfcSecret, rfcCode, rfcNow, rfcStep); ok {
		t.Error("Verify accepted a code at lastStep")
	}
	if _, ok := Verify(rfcSecret, rfcCode, rfcNow, rfcStep+1); ok {
		t.Error("Verify accepted a code below lastStep")
	}
	if _, ok := Verify(rfcSecret, rfcCode, rfcNow, rfcStep-1); !ok {
		t.Error("Verify rejected a code above lastStep")
	}
}

func TestVerifyRejectsWrongCode(t *testing.T) {
	if _, ok := Verify(rfcSecret, "000000", rfcNow, 0); ok {
		t.Error("Verify accepted a wrong code")
	}
}
