package auth

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func testKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	return key
}

func TestSealOpenRoundTrip(t *testing.T) {
	key := testKey(t)
	plaintext := []byte("JBSWY3DPEHPK3PXP")
	sealed, err := Seal(key, plaintext, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	got, err := Open(key, sealed, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Errorf("Open = %q, want %q", got, plaintext)
	}
}

func TestOpenFailsWithOtherUserID(t *testing.T) {
	key := testKey(t)
	sealed, err := Seal(key, []byte("secret"), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(key, sealed, "user-2"); err == nil {
		t.Error("Open with another user ID succeeded")
	}
}

func TestOpenFailsWithTamperedCiphertext(t *testing.T) {
	key := testKey(t)
	sealed, err := Seal(key, []byte("secret"), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	sealed[len(sealed)-1] ^= 0x01
	if _, err := Open(key, sealed, "user-1"); err == nil {
		t.Error("Open of tampered ciphertext succeeded")
	}
	if _, err := Open(key, sealed[:5], "user-1"); err == nil {
		t.Error("Open of truncated ciphertext succeeded")
	}
}

func TestSealIsRandomized(t *testing.T) {
	key := testKey(t)
	a, err := Seal(key, []byte("secret"), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Seal(key, []byte("secret"), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) {
		t.Error("two seals of the same input are equal")
	}
}
