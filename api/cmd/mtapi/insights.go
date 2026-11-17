package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
	"github.com/KaloyanYosifov/money-tracker/api/internal/db"
	"github.com/KaloyanYosifov/money-tracker/api/internal/insights"
)

const insightsUsage = `usage:
  mtapi insights run [--date YYYY-MM-DD] [--portfolio]`

// insightsCmd runs an insights subcommand. It reads DATABASE_URL and
// AI_BASE_URL. The name is not insights, so that main.go can import the
// insights package.
func insightsCmd(args []string, logger *slog.Logger) error {
	if len(args) == 0 || args[0] != "run" {
		return errors.New(insightsUsage)
	}
	fs := flag.NewFlagSet("insights run", flag.ContinueOnError)
	date := fs.String("date", time.Now().Format(time.DateOnly), "the day of the run")
	portfolioOnly := fs.Bool("portfolio", false, "run only the weekly portfolio insights")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	spending, portfolio, err := insightsPlan(*date, *portfolioOnly)
	if err != nil {
		return err
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	aiURL := strings.TrimSpace(os.Getenv("AI_BASE_URL"))
	if aiURL == "" {
		return errors.New("AI_BASE_URL is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// insights.Run logs through the default logger.
	slog.SetDefault(logger)
	client := aiclient.New(aiURL, nil)
	return runInsights(spending, portfolio,
		func() error { return insights.Run(ctx, pool, client, *date) },
		func() error { return insights.RunPortfolio(ctx, pool, client, *date) })
}

// runInsights runs the planned parts. An auth error of the spending run
// stops before the portfolio run.
func runInsights(spending, portfolio bool, runSpending, runPortfolio func() error) error {
	var errs []error
	if spending {
		err := runSpending()
		if errors.Is(err, aiclient.ErrAuth) {
			return err
		}
		errs = append(errs, err)
	}
	if portfolio {
		errs = append(errs, runPortfolio())
	}
	return errors.Join(errs...)
}

// insightsPlan returns which runs to do on date. The spending run is daily
// and the portfolio run is on Mondays. portfolioOnly runs only the portfolio.
func insightsPlan(date string, portfolioOnly bool) (spending, portfolio bool, err error) {
	day, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return false, false, err
	}
	if portfolioOnly {
		return false, true, nil
	}
	return true, day.Weekday() == time.Monday, nil
}
