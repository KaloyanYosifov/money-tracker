package prices

import (
	"math"
	"testing"
)

func TestFormatDecimal(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{172.5, "172.5"},
		{0.00012345, "0.00012345"},
		{100, "100"},
		{0, "0"},
		{1.1234567890126, "1.123456789013"},
		{0.0000000000001, "0"},
		{999999999999.5, "999999999999.5"},
	}
	for _, c := range cases {
		got, err := FormatDecimal(c.in)
		if err != nil {
			t.Errorf("FormatDecimal(%v): %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("FormatDecimal(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFormatDecimalErrors(t *testing.T) {
	for _, in := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -0.5, 1e12} {
		if got, err := FormatDecimal(in); err == nil {
			t.Errorf("FormatDecimal(%v) = %q, want an error", in, got)
		}
	}
}

func TestShiftDecimal(t *testing.T) {
	cases := []struct {
		in     string
		places int
		want   string
	}{
		{"2685", 2, "26.85"},
		{"5.5", 2, "0.055"},
		{"0.1", 2, "0.001"},
		{"2600", 2, "26"},
		{"0", 2, "0"},
		{"12.34", 0, "12.34"},
	}
	for _, c := range cases {
		if got := ShiftDecimal(c.in, c.places); got != c.want {
			t.Errorf("ShiftDecimal(%q, %d) = %q, want %q", c.in, c.places, got, c.want)
		}
	}
}
