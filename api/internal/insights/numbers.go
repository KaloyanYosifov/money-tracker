package insights

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	numberToken   = regexp.MustCompile(`\d+(?:[.,]\d+)*`)
	currencyField = regexp.MustCompile(`"(?:currency_code|quote_currency|currency)":"([A-Za-z]{3})"`)
)

// checkNumbers returns an error that names the first number of the card title
// or body that is not a number of the input JSON text. Tokens with the same
// decimal value, such as "100.0" and "100", match. A number with a minus sign
// must be negative in the input; a number without one may have either sign.
// The integers 0 to 12 are allowed as counts, but not as a percent or an
// amount that is not in the input.
func checkNumbers(card Card, input []byte) error {
	allowed := map[string]bool{}
	for _, n := range numbersOf(string(input)) {
		allowed[n.signed()] = true
	}
	var units []string
	for _, m := range currencyField.FindAllStringSubmatch(string(input), -1) {
		units = append(units, m[1])
	}
	for _, text := range []string{card.Title, card.Body} {
		for _, n := range numbersOf(text) {
			if allowed[n.signed()] || n.sign == 0 && allowed["-"+n.value] {
				continue
			}
			if small(n.value) && n.sign == 0 && !unitAfter(text[n.end:], units) && !unitBefore(text[:n.start], units) {
				continue
			}
			return fmt.Errorf("the number %s is not in the input", text[n.start:n.end])
		}
	}
	return nil
}

// number is a number token of a text. sign is '-' or '+' when the text writes
// one, else 0.
type number struct {
	value      string
	sign       rune
	start, end int
}

func (n number) signed() string {
	if n.sign == '-' {
		return "-" + n.value
	}
	return n.value
}

// numbersOf returns the number tokens of text. A minus (-, U+2212 or an en
// dash) or a plus right before a token is its sign, unless a letter or a digit
// is before it, as in the date 2026-11-16 or the range 5-10.
func numbersOf(text string) []number {
	var out []number
	for _, loc := range numberToken.FindAllStringIndex(text, -1) {
		n := number{value: canonicalNumber(text[loc[0]:loc[1]]), start: loc[0], end: loc[1]}
		mark, size := utf8.DecodeLastRuneInString(text[:loc[0]])
		if strings.ContainsRune("-\u2212\u2013+", mark) {
			before, _ := utf8.DecodeLastRuneInString(text[:loc[0]-size])
			if loc[0] == size || !unicode.IsLetter(before) && !unicode.IsDigit(before) {
				n.sign = '-'
				if mark == '+' {
					n.sign = '+'
				}
				n.start = loc[0] - size
			}
		}
		out = append(out, n)
	}
	return out
}

func small(value string) bool {
	i, err := strconv.Atoi(value)
	return err == nil && i >= 0 && i <= 12
}

// unitAfter reports whether rest starts with a percent sign, the word
// percent or a currency code, after at most one space.
func unitAfter(rest string, units []string) bool {
	rest = trimSpace(rest, strings.TrimPrefix)
	for _, u := range append([]string{"%", "percent"}, units...) {
		if strings.HasPrefix(rest, u) {
			return true
		}
	}
	return false
}

// unitBefore reports whether before ends with a currency code or a currency
// sign, after at most one space.
func unitBefore(before string, units []string) bool {
	before = trimSpace(before, strings.TrimSuffix)
	for _, u := range append([]string{"€", "$", "£"}, units...) {
		if strings.HasSuffix(before, u) {
			return true
		}
	}
	return false
}

func trimSpace(s string, trim func(string, string) string) string {
	return trim(trim(s, " "), "\u00a0")
}

// canonicalNumber drops the trailing fraction zeros of a token with one
// decimal point. A token with a comma does not change.
func canonicalNumber(token string) string {
	if strings.Count(token, ".") != 1 || strings.Contains(token, ",") {
		return token
	}
	return strings.TrimSuffix(strings.TrimRight(token, "0"), ".")
}
