package auth

import (
	"crypto/subtle"
	"net/url"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const (
	totpIssuer = "Money Tracker"
	totpPeriod = 30
)

var totpOpts = totp.ValidateOpts{
	Period:    totpPeriod,
	Digits:    otp.DigitsSix,
	Algorithm: otp.AlgorithmSHA1,
}

// NewTOTPSecret makes a random base32 TOTP secret and its otpauth:// URL for
// an authenticator app. The library URL encodes the issuer as "Money+Tracker"
// in the query, so the URL is built here with %20.
func NewTOTPSecret(email string) (secret, otpURL string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      totpIssuer,
		AccountName: email,
		Period:      totpPeriod,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return "", "", err
	}
	secret = key.Secret()
	issuer := url.PathEscape(totpIssuer)
	otpURL = "otpauth://totp/" + url.PathEscape(totpIssuer+":"+email) +
		"?secret=" + secret + "&issuer=" + issuer +
		"&algorithm=SHA1&digits=6&period=30"
	return secret, otpURL, nil
}

// Verify checks code against the steps now-30s, now and now+30s. It returns
// the matched step. A step at or below lastStep is never accepted, so a code
// cannot be used two times.
func Verify(secret, code string, now time.Time, lastStep int64) (int64, bool) {
	if len(code) != 6 {
		return 0, false
	}
	current := now.Unix() / totpPeriod
	for step := current - 1; step <= current+1; step++ {
		if step <= lastStep {
			continue
		}
		want, err := totp.GenerateCodeCustom(secret, time.Unix(step*totpPeriod, 0), totpOpts)
		if err != nil {
			return 0, false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}
