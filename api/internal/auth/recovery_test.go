package auth

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
)

var recoveryCodeFormat = regexp.MustCompile(`^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$`)

func TestGenerateRecoveryCodes(t *testing.T) {
	codes, hashes, err := GenerateRecoveryCodes()
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != 10 || len(hashes) != 10 {
		t.Fatalf("got %d codes and %d hashes, want 10 and 10", len(codes), len(hashes))
	}
	seen := map[string]bool{}
	for i, code := range codes {
		if !recoveryCodeFormat.MatchString(code) {
			t.Errorf("code %q does not have the format xxxxx-xxxxx", code)
		}
		if seen[code] {
			t.Errorf("code %q occurs two times", code)
		}
		seen[code] = true
		if len(hashes[i]) != 32 {
			t.Errorf("hash %d has %d bytes, want 32 (SHA-256)", i, len(hashes[i]))
		}
		if !bytes.Equal(hashes[i], HashRecoveryCode(code)) {
			t.Errorf("hash %d does not match HashRecoveryCode(%q)", i, code)
		}
	}
}

func TestRecoveryCodeMatchIgnoresCaseAndDash(t *testing.T) {
	codes, hashes, err := GenerateRecoveryCodes()
	if err != nil {
		t.Fatal(err)
	}
	code, hash := codes[0], hashes[0]
	inputs := []string{
		code,
		strings.ToUpper(code),
		strings.ReplaceAll(code, "-", ""),
		" " + strings.ToUpper(strings.ReplaceAll(code, "-", "")) + " ",
	}
	for _, in := range inputs {
		if !bytes.Equal(HashRecoveryCode(in), hash) {
			t.Errorf("HashRecoveryCode(%q) does not match the hash of %q", in, code)
		}
	}
	if bytes.Equal(HashRecoveryCode("00000-00000"), hash) && code != "00000-00000" {
		t.Error("a different code matches the hash")
	}
}
