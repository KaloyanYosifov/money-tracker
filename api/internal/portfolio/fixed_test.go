package portfolio_test

import (
	"math/big"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/portfolio"
)

func fixed(t *testing.T, s string) *big.Int {
	t.Helper()
	v, ok := portfolio.ParseFixed(s)
	if !ok {
		t.Fatalf("ParseFixed(%q) failed", s)
	}
	return v
}

func neg(v *big.Int) *big.Int { return new(big.Int).Neg(v) }

func TestParseFixed(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"1", "1000000000000", true},
		{"0.5", "500000000000", true},
		{".5", "500000000000", true},
		{"5.", "5000000000000", true},
		{"12.000000000001", "12000000000001", true},
		{"", "", false},
		{".", "", false},
		{"abc", "", false},
		{"-1", "", false},
		{"1.2.3", "", false},
		{"1.0000000000001", "", false},
	}
	for _, c := range cases {
		got, ok := portfolio.ParseFixed(c.in)
		if ok != c.ok {
			t.Errorf("ParseFixed(%q) ok = %v, want %v", c.in, ok, c.ok)
			continue
		}
		if ok && got.String() != c.want {
			t.Errorf("ParseFixed(%q) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestFormatFixed(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"1000000000000", "1"},
		{"1500000000000", "1.5"},
		{"-1500000000000", "-1.5"},
		{"1", "0.000000000001"},
		{"-1", "-0.000000000001"},
		{"0", "0"},
	}
	for _, c := range cases {
		v, _ := new(big.Int).SetString(c.in, 10)
		if got := portfolio.FormatFixed(v); got != c.want {
			t.Errorf("FormatFixed(%s) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMulDiv(t *testing.T) {
	cases := []struct {
		name string
		got  *big.Int
		want string
	}{
		{"mul", portfolio.Mul(fixed(t, "2.5"), fixed(t, "4")), "10"},
		{"mul negative", portfolio.Mul(neg(fixed(t, "2.5")), fixed(t, "4")), "-10"},
		{"mul half up", portfolio.Mul(fixed(t, "0.000000000001"), fixed(t, "0.5")), "0.000000000001"},
		{"mul half away from zero", portfolio.Mul(neg(fixed(t, "0.000000000001")), fixed(t, "0.5")), "-0.000000000001"},
		{"mul below half", portfolio.Mul(fixed(t, "0.000000000001"), fixed(t, "0.4")), "0"},
		{"div", portfolio.Div(fixed(t, "10"), fixed(t, "4")), "2.5"},
		{"div rounds", portfolio.Div(fixed(t, "2"), fixed(t, "3")), "0.666666666667"},
		{"div negative", portfolio.Div(fixed(t, "2"), neg(fixed(t, "3"))), "-0.666666666667"},
		{"div half away from zero", portfolio.Div(neg(fixed(t, "0.000000000001")), fixed(t, "2")), "-0.000000000001"},
	}
	for _, c := range cases {
		if got := portfolio.FormatFixed(c.got); got != c.want {
			t.Errorf("%s = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestFormatAmount(t *testing.T) {
	cases := []struct {
		in   *big.Int
		want string
	}{
		{fixed(t, "1234.555"), "1234.56"},
		{neg(fixed(t, "0.005")), "-0.01"},
		{fixed(t, "0"), "0.00"},
		{fixed(t, "1234567.8"), "1234567.80"},
		{neg(fixed(t, "0.004")), "0.00"},
	}
	for _, c := range cases {
		if got := portfolio.FormatAmount(c.in, 2); got != c.want {
			t.Errorf("FormatAmount(%s, 2) = %q, want %q", portfolio.FormatFixed(c.in), got, c.want)
		}
	}
}

func TestFormatPercent(t *testing.T) {
	cases := []struct {
		part, whole string
		want        string
		ok          bool
	}{
		{"425", "1000", "42.5", true},
		{"1000", "1000", "100.0", true},
		{"1", "3", "33.3", true},
		{"2", "3", "66.7", true},
		{"0", "1000", "0.0", true},
		{"1", "0", "", false},
	}
	for _, c := range cases {
		got, ok := portfolio.FormatPercent(fixed(t, c.part), fixed(t, c.whole))
		if ok != c.ok || got != c.want {
			t.Errorf("FormatPercent(%s, %s) = %q, %v, want %q, %v", c.part, c.whole, got, ok, c.want, c.ok)
		}
	}
}
