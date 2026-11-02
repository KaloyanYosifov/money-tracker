package prices

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The limits of a decimal string in the schemas.
const (
	maxIntDigits  = 12
	maxFracDigits = 12
)

// FormatDecimal formats v as a decimal string with at most 12 fraction
// digits. It rejects NaN, Inf, negative values and values with more than 12
// integer digits.
func FormatDecimal(v float64) (string, error) {
	return formatDecimal(v, maxFracDigits)
}

func formatDecimal(v float64, fracDigits int) (string, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return "", fmt.Errorf("prices: invalid decimal %v", v)
	}
	s := strconv.FormatFloat(v, 'f', -1, 64)
	if i := strings.IndexByte(s, '.'); i >= 0 && len(s)-i-1 > fracDigits {
		s = trimDecimal(strconv.FormatFloat(v, 'f', fracDigits, 64))
	}
	if s == "-0" {
		s = "0"
	}
	intPart, _, _ := strings.Cut(s, ".")
	if len(intPart) > maxIntDigits {
		return "", fmt.Errorf("prices: decimal %v has more than %d integer digits", v, maxIntDigits)
	}
	return s, nil
}

// ShiftDecimal divides the decimal string s by 10^places. It moves the
// decimal point and does no float math.
func ShiftDecimal(s string, places int) string {
	intPart, fracPart, _ := strings.Cut(s, ".")
	digits := intPart + fracPart
	point := len(intPart) - places
	if point <= 0 {
		digits = strings.Repeat("0", 1-point) + digits
		point = 1
	}
	return trimDecimal(digits[:point] + "." + digits[point:])
}

// trimDecimal removes the zeros at the start of the integer part and at the
// end of the fraction.
func trimDecimal(s string) string {
	intPart, fracPart, _ := strings.Cut(s, ".")
	intPart = strings.TrimLeft(intPart, "0")
	if intPart == "" {
		intPart = "0"
	}
	fracPart = strings.TrimRight(fracPart, "0")
	if fracPart == "" {
		return intPart
	}
	return intPart + "." + fracPart
}
