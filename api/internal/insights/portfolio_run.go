package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
)

// RunPortfolio writes new portfolio cards for each user who turned insights
// on and has trades. today is the day of the run as YYYY-MM-DD. The error
// rules are the same as in Run.
func RunPortfolio(ctx context.Context, pool *pgxpool.Pool, client AIClient, today string) error {
	day, err := time.Parse(time.DateOnly, today)
	if err != nil {
		return fmt.Errorf("today %q is not a YYYY-MM-DD date: %w", today, err)
	}
	userIDs, err := portfolioUsers(ctx, pool, today)
	if err != nil {
		return err
	}

	failed := 0
	for _, userID := range userIDs {
		err := runPortfolioOne(ctx, pool, client, userID, today, day.Add(-retention))
		if errors.Is(err, aiclient.ErrAuth) {
			return fmt.Errorf("portfolio insights run stopped at user %s: %w", userID, err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			slog.Error("portfolio insights run failed for a user", "user_id", userID, "err", err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("portfolio insights run failed for %d of %d users", failed, len(userIDs))
	}
	return nil
}

// runPortfolioOne runs the portfolio task for one user and writes the checked
// cards.
func runPortfolioOne(ctx context.Context, pool *pgxpool.Pool, client AIClient, userID, today string, pruneBefore time.Time) error {
	input, err := readPortfolioData(ctx, pool, userID, today)
	if err != nil {
		return err
	}
	numbers, err := numberSource(input)
	if err != nil {
		return fmt.Errorf("marshal input: %w", err)
	}
	result, err := client.PortfolioInsights(ctx, input)
	if err != nil {
		return err
	}

	cards := make([]Card, 0, len(result.Cards))
	used := map[string]bool{}
	for _, c := range result.Cards {
		card := Card(c)
		if err := checkPortfolioCard(card, numbers, input.DismissedFingerprints, used); err != nil {
			slog.Warn("portfolio insights card dropped", "user_id", userID, "kind", card.Kind, "fingerprint", card.Fingerprint, "err", err)
			continue
		}
		cards = append(cards, card)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pruneCards(ctx, tx, userID, SourcePortfolio, pruneBefore); err != nil {
		return err
	}
	// When the checks drop every card of the answer, the open cards and the
	// saved summary stay, because the new summary describes the dropped cards.
	if keep := len(cards) == 0 && len(result.Cards) > 0; !keep {
		if err := replaceOpenCards(ctx, tx, userID, SourcePortfolio, cards); err != nil {
			return err
		}
		// A blank summary keeps the saved one, so one bad run does not wipe it.
		if strings.TrimSpace(result.Summary) != "" {
			if err := saveMemory(ctx, tx, userID, SourcePortfolio, limitSummary(result.Summary)); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// numberSource is the input JSON without the instrument names, the summary
// and the earlier cards. Only numbers that the code computed pass checkNumbers.
func numberSource(in PortfolioInput) ([]byte, error) {
	in.Summary = ""
	in.RecentCards = nil
	in.DismissedFingerprints = nil
	in.Holdings = slices.Clone(in.Holdings)
	for i := range in.Holdings {
		in.Holdings[i].Name = ""
	}
	return json.Marshal(in)
}

// checkPortfolioCard reports why a card of the portfolio task is not written.
// numbers is the JSON of numberSource.
func checkPortfolioCard(card Card, numbers []byte, dismissed []string, used map[string]bool) error {
	if card.Kind != KindTip {
		return fmt.Errorf("kind %q is not %q", card.Kind, KindTip)
	}
	if err := CheckCard(card, UserData{}); err != nil {
		return err
	}
	if err := checkNumbers(card, numbers); err != nil {
		return err
	}
	return checkFingerprint(card.Fingerprint, dismissed, used)
}
