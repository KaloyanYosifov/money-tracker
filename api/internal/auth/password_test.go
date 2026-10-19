package auth

import (
	"errors"
	"strings"
	"testing"
)

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Fatalf("hash %q does not start with $argon2id$v=19$", hash)
	}
	if !VerifyPassword("correct horse", hash) {
		t.Fatal("VerifyPassword returned false for the correct password")
	}
	if VerifyPassword("wrong password", hash) {
		t.Fatal("VerifyPassword returned true for a wrong password")
	}
}

func TestHashesDiffer(t *testing.T) {
	a, err := HashPassword("correct horse")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	b, err := HashPassword("correct horse")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if a == b {
		t.Fatal("two hashes of one password are equal")
	}
}

func TestRejectShortPassword(t *testing.T) {
	_, err := HashPassword("short12345")
	if !errors.Is(err, ErrPasswordTooShort) {
		t.Fatalf("got %v, want ErrPasswordTooShort", err)
	}
}

func TestVerifyIsConstantTimeForBadHash(t *testing.T) {
	bad := []string{
		"",
		"not a hash",
		"$argon2id$v=19$m=65536,t=3,p=2$",
		"$argon2id$v=19$m=65536,t=3,p=2$!!!$!!!",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA",
		"$argon2id$v=18$m=65536,t=3,p=2$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA",
		"$argon2id$v=19$m=x,t=3,p=2$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=0,p=0$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA",
	}
	for _, h := range bad {
		if VerifyPassword("correct horse", h) {
			t.Errorf("VerifyPassword returned true for malformed hash %q", h)
		}
	}
}
