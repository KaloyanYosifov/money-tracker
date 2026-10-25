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
  mtapi insights run [--date YYYY-MM-DD]`

// insightsCmd runs an insights subcommand. It reads DATABASE_URL and
// AI_BASE_URL. The name is not insights, so that main.go can import the
// insights package.
func insightsCmd(args []string, logger *slog.Logger) error {
	if len(args) == 0 || args[0] != "run" {
		return errors.New(insightsUsage)
	}
	fs := flag.NewFlagSet("insights run", flag.ContinueOnError)
	date := fs.String("date", time.Now().Format(time.DateOnly), "the day of the run")
	if err := fs.Parse(args[1:]); err != nil {
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
	return insights.Run(ctx, pool, aiclient.New(aiURL, nil), *date)
}
