package insights

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

func TestRunPortfolio(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	today := time.Now().UTC().Format(time.DateOnly)
	daysAgo := func(n int) string { return time.Now().UTC().AddDate(0, 0, -n).Format(time.DateOnly) }

	// addHolding gives u an open holding of symbol with the value 125.00 EUR.
	addHolding := func(t *testing.T, u runUser, symbol string) {
		t.Helper()
		id := addInstrument(t, pool, u, symbol, "Synthetic "+symbol, "stock", "EUR")
		addTrade(t, pool, u, id, "buy", daysAgo(10), "10", "10", "0", "")
		addClose(t, pool, id, daysAgo(1), "12.5")
	}
	memory := func(t *testing.T, u runUser, source string) string {
		t.Helper()
		var summary string
		if err := pool.QueryRow(ctx, `SELECT summary FROM insight_memory WHERE user_id = $1 AND source = $2`,
			u.userID, source).Scan(&summary); err != nil {
			t.Fatal(err)
		}
		return summary
	}
	symbolOf := func(in PortfolioInput) string {
		if len(in.Holdings) == 0 {
			return ""
		}
		return in.Holdings[0].Symbol
	}

	t.Run("writes_cards", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-writes@example.com", true)
		addHolding(t, u, "PWA")
		addPortfolioCard(t, pool, u, "open", "portfolio:old", 1)

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{
				Cards:   []aiclient.Card{tipCard("portfolio:a"), tipCard("portfolio:b")},
				Summary: "Portfolio summary.",
			}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if fake.portfolioCalls() != 1 || fake.calls() != 0 {
			t.Fatalf("portfolio, daily calls = %d, %d, want 1, 0", fake.portfolioCalls(), fake.calls())
		}
		if in := fake.portfolioInputs[0]; in.Today != today || symbolOf(in) != "PWA" {
			t.Errorf("input today, symbol = %q, %q", in.Today, symbolOf(in))
		}
		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"portfolio:a", "portfolio:b"}) {
			t.Errorf("open cards = %v", got)
		}
		if n := countRows(t, pool,
			`SELECT count(*) FROM insights WHERE user_id = $1 AND status = 'open' AND source = 'portfolio'`, u.userID); n != 2 {
			t.Errorf("open portfolio cards = %d, want 2", n)
		}
		if got := memory(t, u, SourcePortfolio); got != "Portfolio summary." {
			t.Errorf("portfolio memory = %q", got)
		}
	})

	t.Run("keeps_spending_cards", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-keeps@example.com", true)
		addHolding(t, u, "PKA")
		addCard(t, pool, u, "open", "tip:spending", 1)
		execSQL(t, pool,
			`INSERT INTO insight_memory (user_id, summary, updated_at) VALUES ($1, 'spending memory', '2026-01-01T00:00:00Z')`,
			u.userID)

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("portfolio:new")}, Summary: "Portfolio summary."}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if n := countRows(t, pool,
			`SELECT count(*) FROM insights WHERE user_id = $1 AND fingerprint = 'tip:spending' AND status = 'open' AND source = 'spending'`,
			u.userID); n != 1 {
			t.Errorf("open spending cards = %d, want 1", n)
		}
		var summary string
		var updatedAt time.Time
		if err := pool.QueryRow(ctx,
			`SELECT summary, updated_at FROM insight_memory WHERE user_id = $1 AND source = 'spending'`,
			u.userID).Scan(&summary, &updatedAt); err != nil {
			t.Fatal(err)
		}
		if summary != "spending memory" || !updatedAt.Equal(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)) {
			t.Errorf("spending memory = %q at %s, want it unchanged", summary, updatedAt)
		}
	})

	t.Run("no_trades_no_call", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-no-trades@example.com", true)
		addInstrument(t, pool, u, "PNA", "Synthetic PNA", "stock", "EUR")

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("portfolio:x")}, Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if fake.portfolioCalls() != 0 {
			t.Errorf("gateway calls = %d, want 0", fake.portfolioCalls())
		}
	})

	t.Run("switch_off_no_call", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-off@example.com", false)
		addHolding(t, u, "POA")

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("portfolio:x")}, Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if fake.portfolioCalls() != 0 {
			t.Errorf("gateway calls = %d, want 0", fake.portfolioCalls())
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1`, u.userID); n != 0 {
			t.Errorf("cards = %d, want 0", n)
		}
	})

	t.Run("drops_invented_numbers", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-numbers@example.com", true)
		addHolding(t, u, "PDA")

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			known := tipCard("portfolio:known")
			known.Body = "PDA is worth 125.00."
			invented := tipCard("portfolio:invented")
			invented.Body = "PDA is worth 99999.99."
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{known, invented}, Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"portfolio:known"}) {
			t.Errorf("open cards = %v", got)
		}
	})

	t.Run("drops_non_tips", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-non-tips@example.com", true)
		addHolding(t, u, "PTA")

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{
				budgetCard("portfolio:budget", u.expenseCatID, 10000),
				tipCard("portfolio:tip"),
			}, Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"portfolio:tip"}) {
			t.Errorf("open cards = %v", got)
		}
	})

	t.Run("drops_dismissed_and_duplicate_fingerprints", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-fingerprints@example.com", true)
		addHolding(t, u, "PFA")
		addPortfolioCard(t, pool, u, "dismissed", "portfolio:gone", 1)

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{
				tipCard("portfolio:gone"),
				tipCard("portfolio:twice"),
				tipCard("portfolio:twice"),
			}, Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"portfolio:twice"}) {
			t.Errorf("open cards = %v", got)
		}
	})

	t.Run("keeps_open_cards_when_every_card_is_dropped", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-all-dropped@example.com", true)
		addHolding(t, u, "PKD")
		addPortfolioCard(t, pool, u, "open", "portfolio:still", 1)
		addPortfolioMemory(t, pool, u, "old memory")

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			bad := tipCard("portfolio:bad")
			bad.Body = "It is worth 99999.99."
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{bad}, Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"portfolio:still"}) {
			t.Errorf("open cards = %v, want the old card", got)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insight_memory WHERE user_id = $1 AND source = 'portfolio' AND summary = 'old memory'`, u.userID); n != 1 {
			t.Errorf("the summary of the dropped cards replaced the saved one")
		}
	})

	t.Run("auth_stops", func(t *testing.T) {
		a := seedRunUser(t, pool, "portfolio-auth-a@example.com", true)
		b := seedRunUser(t, pool, "portfolio-auth-b@example.com", true)
		execSQL(t, pool, `UPDATE user_settings SET insights_enabled = true WHERE user_id IN ($1, $2)`, a.userID, b.userID)
		addHolding(t, a, "PAA")
		addHolding(t, b, "PAB")

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{}, fmt.Errorf("call: %w", aiclient.ErrAuth)
		}}
		err := RunPortfolio(ctx, pool, fake, today)
		if !errors.Is(err, aiclient.ErrAuth) {
			t.Fatalf("RunPortfolio = %v, want ErrAuth", err)
		}
		if fake.portfolioCalls() != 1 {
			t.Errorf("gateway calls = %d, want 1", fake.portfolioCalls())
		}
	})

	t.Run("other_error_skips_user", func(t *testing.T) {
		a := seedRunUser(t, pool, "portfolio-skip-a@example.com", true)
		b := seedRunUser(t, pool, "portfolio-skip-b@example.com", true)
		execSQL(t, pool, `UPDATE user_settings SET insights_enabled = true WHERE user_id IN ($1, $2)`, a.userID, b.userID)
		addHolding(t, a, "PSA")
		addHolding(t, b, "PSB")
		addPortfolioCard(t, pool, a, "open", "portfolio:a-old", 1)

		fake := &fakeAI{respondPortfolio: func(in PortfolioInput) (aiclient.DailyInsightsResult, error) {
			if symbolOf(in) == "PSA" {
				return aiclient.DailyInsightsResult{}, fmt.Errorf("call: %w", aiclient.ErrTimeout)
			}
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("portfolio:b-new")}, Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err == nil {
			t.Fatal("RunPortfolio = nil, want an error")
		}
		if fake.portfolioCalls() != 2 {
			t.Errorf("gateway calls = %d, want 2", fake.portfolioCalls())
		}
		if got := openFingerprints(t, pool, a.userID); !slices.Equal(got, []string{"portfolio:a-old"}) {
			t.Errorf("user A open cards = %v", got)
		}
		if got := openFingerprints(t, pool, b.userID); !slices.Equal(got, []string{"portfolio:b-new"}) {
			t.Errorf("user B open cards = %v", got)
		}
	})

	t.Run("blank_summary_keeps_memory", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-blank@example.com", true)
		addHolding(t, u, "PBA")
		addPortfolioMemory(t, pool, u, "portfolio memory")

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("portfolio:x")}, Summary: "  "}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if got := memory(t, u, SourcePortfolio); got != "portfolio memory" {
			t.Errorf("portfolio memory = %q, want the saved summary", got)
		}
	})

	t.Run("prunes_old_portfolio_cards", func(t *testing.T) {
		u := seedRunUser(t, pool, "portfolio-prunes@example.com", true)
		addHolding(t, u, "PPA")
		addPortfolioCard(t, pool, u, "accepted", "portfolio:61", 61)
		addPortfolioCard(t, pool, u, "accepted", "portfolio:59", 59)
		addCard(t, pool, u, "accepted", "tip:61", 61)
		execSQL(t, pool,
			`INSERT INTO insight_questions (id, user_id, category_id, question, status, created_at, updated_at)
			 VALUES (gen_random_uuid(), $1, $2, 'Answered question?', 'answered',
			         now() - make_interval(days => 61), now() - make_interval(days => 61))`,
			u.userID, u.expenseCatID)

		fake := &fakeAI{respondPortfolio: func(PortfolioInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Summary: "s"}, nil
		}}
		if err := RunPortfolio(ctx, pool, fake, today); err != nil {
			t.Fatalf("RunPortfolio: %v", err)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1 AND fingerprint = 'portfolio:61'`, u.userID); n != 0 {
			t.Errorf("61-day-old portfolio card is still there")
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1 AND fingerprint = 'portfolio:59'`, u.userID); n != 1 {
			t.Errorf("59-day-old portfolio card is gone")
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1 AND fingerprint = 'tip:61'`, u.userID); n != 1 {
			t.Errorf("61-day-old spending card is gone")
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insight_questions WHERE user_id = $1`, u.userID); n != 1 {
			t.Errorf("61-day-old answered question is gone, but only the spending run prunes questions")
		}
	})
}
