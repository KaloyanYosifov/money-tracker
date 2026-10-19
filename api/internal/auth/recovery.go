package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"strings"
)

const (
	recoveryCodeCount = 10
	// Crockford base32 in lowercase: no i, l, o or u.
	recoveryAlphabet = "0123456789abcdefghjkmnpqrstvwxyz"
)

// GenerateRecoveryCodes returns 10 codes in the format xxxxx-xxxxx and the
// SHA-256 hash of each code. Store only the hashes.
func GenerateRecoveryCodes() (codes []string, hashes [][]byte, err error) {
	codes = make([]string, 0, recoveryCodeCount)
	hashes = make([][]byte, 0, recoveryCodeCount)
	seen := map[string]bool{}
	buf := make([]byte, 10)
	for len(codes) < recoveryCodeCount {
		if _, err := rand.Read(buf); err != nil {
			return nil, nil, err
		}
		var b strings.Builder
		for i, c := range buf {
			if i == 5 {
				b.WriteByte('-')
			}
			b.WriteByte(recoveryAlphabet[c%32])
		}
		code := b.String()
		if seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
		hashes = append(hashes, HashRecoveryCode(code))
	}
	return codes, hashes, nil
}

// HashRecoveryCode returns the SHA-256 hash of a recovery code. It ignores
// case, dashes and surrounding spaces, so "ABCDE-12345" and "abcde12345"
// give the same hash.
func HashRecoveryCode(code string) []byte {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	sum := sha256.Sum256([]byte(normalized))
	return sum[:]
}
