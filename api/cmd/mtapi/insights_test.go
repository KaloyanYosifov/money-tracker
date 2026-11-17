package main

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
)

func TestInsightsPlan(t *testing.T) {
	tests := []struct {
		name          string
		date          string
		portfolioOnly bool
		spending      bool
		portfolio     bool
	}{
		{"monday runs both", "2026-11-16", false, true, true},
		{"tuesday runs spending only", "2026-11-17", false, true, false},
		{"flag on monday runs portfolio only", "2026-11-16", true, false, true},
		{"flag on tuesday runs portfolio only", "2026-11-17", true, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spending, portfolio, err := insightsPlan(tt.date, tt.portfolioOnly)
			if err != nil {
				t.Fatalf("insightsPlan: %v", err)
			}
			if spending != tt.spending || portfolio != tt.portfolio {
				t.Errorf("insightsPlan = (%v, %v), want (%v, %v)", spending, portfolio, tt.spending, tt.portfolio)
			}
		})
	}

	t.Run("bad date", func(t *testing.T) {
		if _, _, err := insightsPlan("2026-13-01", false); err == nil {
			t.Error("insightsPlan returned no error for a bad date")
		}
	})
}

func TestInsightsCmdChecksTheDateFirst(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	err := insightsCmd([]string{"run", "--date", "2026-13-01"}, slog.Default())
	if err == nil || strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("insightsCmd = %v, want the date error", err)
	}
}

func TestRunInsights(t *testing.T) {
	ranPortfolio := false
	portfolio := func() error { ranPortfolio = true; return nil }

	authErr := fmt.Errorf("call: %w", aiclient.ErrAuth)
	if err := runInsights(true, true, func() error { return authErr }, portfolio); !errors.Is(err, aiclient.ErrAuth) {
		t.Errorf("runInsights = %v, want the auth error", err)
	}
	if ranPortfolio {
		t.Error("the portfolio run started after an auth error")
	}

	other := errors.New("one user failed")
	err := runInsights(true, true, func() error { return other }, portfolio)
	if !errors.Is(err, other) || !ranPortfolio {
		t.Errorf("runInsights = %v, ran portfolio = %v, want the error and a portfolio run", err, ranPortfolio)
	}
}
