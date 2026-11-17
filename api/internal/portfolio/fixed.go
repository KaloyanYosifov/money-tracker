// Package portfolio computes holdings and portfolio facts. It is a Go copy of app/src/domain/portfolio.ts.
package portfolio

import (
	"math/big"
	"regexp"
	"strings"
)

// Fixed-point math for quantities, prices and rates: a *big.Int with the scale 10^12.
const scaleDigits = 12

var (
	scale        = pow10(scaleDigits)
	fixedPattern = regexp.MustCompile(`^(\d*)(?:\.(\d*))?$`)
)

func pow10(n int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
}

// divRound divides and rounds half away from zero.
func divRound(numerator, denominator *big.Int) *big.Int {
	negative := numerator.Sign() < 0 != (denominator.Sign() < 0)
	n := new(big.Int).Abs(numerator)
	d := new(big.Int).Abs(denominator)
	n.Add(n.Lsh(n, 1), d)
	q := n.Quo(n, d.Lsh(d, 1))
	if negative {
		q.Neg(q)
	}
	return q
}

// ParseFixed parses an unsigned decimal string with "." as the separator.
// It fails if the string has no digits or more than 12 fraction digits.
func ParseFixed(s string) (*big.Int, bool) {
	m := fixedPattern.FindStringSubmatch(s)
	if m == nil || m[1]+m[2] == "" || len(m[2]) > scaleDigits {
		return nil, false
	}
	v, ok := new(big.Int).SetString(m[1]+m[2]+strings.Repeat("0", scaleDigits-len(m[2])), 10)
	return v, ok
}

func FormatFixed(v *big.Int) string {
	s := formatScaled(v, scaleDigits)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

func Mul(a, b *big.Int) *big.Int {
	return divRound(new(big.Int).Mul(a, b), scale)
}

func Div(a, b *big.Int) *big.Int {
	return divRound(new(big.Int).Mul(a, scale), b)
}

// FormatAmount rounds v to the given number of fraction digits and formats it without a thousands separator.
func FormatAmount(v *big.Int, digits int) string {
	return formatScaled(divRound(v, pow10(scaleDigits-digits)), digits)
}

// FormatPercent formats part as a percent of whole with 1 fraction digit and no "%" sign.
// It fails if whole is zero.
func FormatPercent(part, whole *big.Int) (string, bool) {
	if whole.Sign() == 0 {
		return "", false
	}
	return formatScaled(divRound(new(big.Int).Mul(part, big.NewInt(1000)), whole), 1), true
}

// formatScaled formats v, an integer in units of 10^-digits, with exactly digits fraction digits.
func formatScaled(v *big.Int, digits int) string {
	sign := ""
	if v.Sign() < 0 {
		sign = "-"
	}
	s := new(big.Int).Abs(v).String()
	if len(s) <= digits {
		s = strings.Repeat("0", digits+1-len(s)) + s
	}
	if digits == 0 {
		return sign + s
	}
	return sign + s[:len(s)-digits] + "." + s[len(s)-digits:]
}

// minorUnitsOf has the currencies with other than 2 minor units, the same as
// Intl.NumberFormat in the app (ICU 78).
var minorUnitsOf = map[string]int{
	"AFN": 0, "ALL": 0, "BIF": 0, "CLP": 0, "COP": 0, "DJF": 0, "GNF": 0, "HUF": 0, "IDR": 0,
	"IQD": 0, "IRR": 0, "ISK": 0, "JPY": 0, "KMF": 0, "KPW": 0, "KRW": 0, "LAK": 0, "LBP": 0,
	"MGA": 0, "MMK": 0, "PKR": 0, "PYG": 0, "RWF": 0, "SLL": 0, "SOS": 0, "SYP": 0, "UGX": 0,
	"VND": 0, "VUV": 0, "XAF": 0, "XOF": 0, "XPF": 0, "YER": 0,
	"BHD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
}

// MinorUnits returns the number of fraction digits of currency, the same as
// minorUnits in app/src/domain/money.ts.
func MinorUnits(currency string) int {
	if n, ok := minorUnitsOf[currency]; ok {
		return n
	}
	return 2
}
