package insights

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
)

// AIClient is the part of the gateway client that insights uses.
// *aiclient.Client implements it.
type AIClient interface {
	DailyInsights(ctx context.Context, input any) (aiclient.DailyInsightsResult, error)
	CategoryQuestion(ctx context.Context, input any) (aiclient.CategoryQuestionResult, error)
}

// Run writes new cards for each user who turned insights on. today is the
// day of the run as YYYY-MM-DD. An auth failure of the gateway stops the run
// at once; another failure skips the user. Run returns an error if any user
// failed.
func Run(ctx context.Context, pool *pgxpool.Pool, client AIClient, today string) error {
	day, err := time.Parse(time.DateOnly, today)
	if err != nil {
		return fmt.Errorf("today %q is not a YYYY-MM-DD date: %w", today, err)
	}
	userIDs, err := optedInUsers(ctx, pool)
	if err != nil {
		return err
	}

	failed := 0
	for _, userID := range userIDs {
		err := runOne(ctx, pool, client, userID, today, day.Add(-retention))
		if errors.Is(err, aiclient.ErrAuth) {
			return fmt.Errorf("insights run stopped at user %s: %w", userID, err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			slog.Error("insights run failed for a user", "user_id", userID, "err", err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("insights run failed for %d of %d users", failed, len(userIDs))
	}
	return nil
}

// runOne runs the daily task for one user and writes the checked cards.
func runOne(ctx context.Context, pool *pgxpool.Pool, client AIClient, userID, today string, pruneBefore time.Time) error {
	input, data, err := readUserData(ctx, pool, userID, today)
	if err != nil {
		return err
	}
	result, err := client.DailyInsights(ctx, input)
	if err != nil {
		return err
	}

	cards := make([]Card, 0, len(result.Cards))
	for _, c := range result.Cards {
		card := Card(c)
		if err := CheckCard(card, data); err != nil {
			slog.Warn("insights card dropped", "user_id", userID, "kind", card.Kind, "fingerprint", card.Fingerprint, "err", err)
			continue
		}
		cards = append(cards, card)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pruneOld(ctx, tx, userID, pruneBefore); err != nil {
		return err
	}
	if err := replaceOpenCards(ctx, tx, userID, cards); err != nil {
		return err
	}
	// A blank summary keeps the saved one, so one bad run does not wipe it.
	if strings.TrimSpace(result.Summary) != "" {
		if err := saveMemory(ctx, tx, userID, limitSummary(result.Summary)); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// maxSummaryLen is the summary limit of the daily_insights output schema.
// The summary goes into each later prompt, so the API does not trust the
// gateway's schema check alone and cuts a longer one.
const maxSummaryLen = 2000

// limitSummary returns summary cut to maxSummaryLen characters.
func limitSummary(summary string) string {
	if utf8.RuneCountInString(summary) <= maxSummaryLen {
		return summary
	}
	return string([]rune(summary)[:maxSummaryLen])
}
