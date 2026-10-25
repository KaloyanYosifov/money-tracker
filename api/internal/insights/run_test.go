package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	gosync "sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

// runUser is one seeded user for the run tests.
type runUser struct {
	userID, accountID, expenseCatID, incomeCatID string
}

// seedRunUser creates a user with the default categories and accounts. Only
// this user has insights_enabled = enabled; the users of earlier subtests are
// switched off, so that each subtest sees only its own users.
func seedRunUser(t *testing.T, pool *pgxpool.Pool, email string, enabled bool) runUser {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var u runUser
	err = tx.QueryRow(ctx,
		`INSERT INTO users (id, email, password_hash, role)
		 VALUES (gen_random_uuid(), $1, 'x', 'user') RETURNING id::text`, email).Scan(&u.userID)
	if err != nil {
		t.Fatal(err)
	}
	if err := users.SeedDefaults(ctx, tx, u.userID, "EUR"); err != nil {
		t.Fatal(err)
	}
	q := func(sql string, dst *string) {
		if err := tx.QueryRow(ctx, sql, u.userID).Scan(dst); err != nil {
			t.Fatal(err)
		}
	}
	q(`SELECT id::text FROM accounts WHERE user_id = $1 AND sort_order = 0`, &u.accountID)
	q(`SELECT id::text FROM categories WHERE user_id = $1 AND type = 'expense' ORDER BY sort_order LIMIT 1`, &u.expenseCatID)
	q(`SELECT id::text FROM categories WHERE user_id = $1 AND type = 'income' ORDER BY sort_order LIMIT 1`, &u.incomeCatID)
	if _, err := tx.Exec(ctx, `UPDATE user_settings SET insights_enabled = (user_id = $1 AND $2)`, u.userID, enabled); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return u
}

func execSQL(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// addCard inserts a card for u with the given status and age in days.
func addCard(t *testing.T, pool *pgxpool.Pool, u runUser, status, fingerprint string, ageDays int) {
	t.Helper()
	execSQL(t, pool,
		`INSERT INTO insights (id, user_id, kind, title, body, fingerprint, status, created_at, updated_at)
		 VALUES (gen_random_uuid(), $1, 'tip', 'Old', 'Old card', $2, $3,
		         now() - make_interval(days => $4), now() - make_interval(days => $4))`,
		u.userID, fingerprint, status, ageDays)
}

// fakeAI is the gateway for the tests. respond answers each daily call.
type fakeAI struct {
	mu      gosync.Mutex
	inputs  []DailyInput
	respond func(in DailyInput) (aiclient.DailyInsightsResult, error)
}

func (f *fakeAI) DailyInsights(_ context.Context, input any) (aiclient.DailyInsightsResult, error) {
	in, ok := input.(DailyInput)
	if !ok {
		return aiclient.DailyInsightsResult{}, fmt.Errorf("input is %T, not DailyInput", input)
	}
	f.mu.Lock()
	f.inputs = append(f.inputs, in)
	f.mu.Unlock()
	return f.respond(in)
}

func (f *fakeAI) CategoryQuestion(context.Context, any) (aiclient.CategoryQuestionResult, error) {
	return aiclient.CategoryQuestionResult{}, errors.New("not used in the run tests")
}

func (f *fakeAI) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.inputs)
}

// owns reports whether the input holds the category, which tells the users
// apart in a fake.
func owns(in DailyInput, categoryID string) bool {
	return slices.ContainsFunc(in.Categories, func(c InputCategory) bool { return c.ID == categoryID })
}

func tipCard(fingerprint string) aiclient.Card {
	return aiclient.Card{Kind: KindTip, Title: "Tip " + fingerprint, Body: "A tip.", Fingerprint: fingerprint, Action: json.RawMessage("null")}
}

func budgetCard(fingerprint, categoryID string, amount int64) aiclient.Card {
	return aiclient.Card{
		Kind: KindBudget, Title: "Budget", Body: "Set a budget.", Fingerprint: fingerprint,
		Action: json.RawMessage(fmt.Sprintf(`{"category_id":%q,"amount_minor":%d}`, categoryID, amount)),
	}
}

func openFingerprints(t *testing.T, pool *pgxpool.Pool, userID string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT fingerprint FROM insights WHERE user_id = $1 AND status = 'open' ORDER BY fingerprint`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			t.Fatal(err)
		}
		out = append(out, fp)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRun(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	today := time.Now().UTC().Format(time.DateOnly)
	daysAgo := func(n int) string { return time.Now().UTC().AddDate(0, 0, -n).Format(time.DateOnly) }

	t.Run("writes cards for an opted-in user", func(t *testing.T) {
		u := seedRunUser(t, pool, "writes@example.com", true)
		for _, d := range []int{1, 30, 89, 120} {
			execSQL(t, pool,
				`INSERT INTO transactions (id, user_id, type, amount_minor, currency_code, date, name, category_id, account_id, note, source)
				 VALUES (gen_random_uuid(), $1, 'expense', 1250, 'EUR', $2, 'Lunch', $3, $4, 'with team', 'manual')`,
				u.userID, daysAgo(d), u.expenseCatID, u.accountID)
		}
		execSQL(t, pool,
			`INSERT INTO budgets (id, user_id, category_id, period, amount_minor)
			 VALUES (gen_random_uuid(), $1, $2, 'monthly', 30000)`, u.userID, u.expenseCatID)
		execSQL(t, pool,
			`INSERT INTO recurring_rules (id, user_id, type, amount_minor, name, category_id, account_id, frequency, start_date)
			 VALUES (gen_random_uuid(), $1, 'income', 250000, 'Salary', $2, $3, 'monthly', '2026-01-01')`,
			u.userID, u.incomeCatID, u.accountID)
		addCard(t, pool, u, "dismissed", "budget:old", 3)
		addCard(t, pool, u, "accepted", "tip:kept", 5)
		execSQL(t, pool, `INSERT INTO insight_memory (user_id, summary) VALUES ($1, 'Eats out a lot.')`, u.userID)

		fake := &fakeAI{respond: func(DailyInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{
				Cards:   []aiclient.Card{tipCard("tip:new"), budgetCard("budget:new", u.expenseCatID, 20000)},
				Summary: "New summary.",
			}, nil
		}}
		if err := Run(ctx, pool, fake, today); err != nil {
			t.Fatalf("Run: %v", err)
		}

		if fake.calls() != 1 {
			t.Fatalf("gateway calls = %d, want 1", fake.calls())
		}
		in := fake.inputs[0]
		if in.Today != today || in.CurrencyCode != "EUR" {
			t.Errorf("today, currency = %q, %q", in.Today, in.CurrencyCode)
		}
		if len(in.Transactions) != 3 {
			t.Errorf("transactions = %d, want 3 (the 120-day-old one is out)", len(in.Transactions))
		}
		if len(in.Categories) != 14 || len(in.Accounts) != 2 {
			t.Errorf("categories, accounts = %d, %d, want 14, 2", len(in.Categories), len(in.Accounts))
		}
		if len(in.Budgets) != 1 || in.Budgets[0].AmountMinor != 30000 {
			t.Errorf("budgets = %+v", in.Budgets)
		}
		if len(in.RecurringRules) != 1 || in.RecurringRules[0].Name != "Salary" {
			t.Errorf("recurring rules = %+v", in.RecurringRules)
		}
		if !slices.Equal(in.DismissedFingerprints, []string{"budget:old"}) {
			t.Errorf("dismissed fingerprints = %v", in.DismissedFingerprints)
		}
		if len(in.RecentCards) != 2 {
			t.Errorf("recent cards = %+v, want 2", in.RecentCards)
		}
		if in.Summary != "Eats out a lot." {
			t.Errorf("summary = %q", in.Summary)
		}

		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"budget:new", "tip:new"}) {
			t.Errorf("open cards = %v", got)
		}
		var action *string
		if err := pool.QueryRow(ctx, `SELECT action::text FROM insights WHERE user_id = $1 AND fingerprint = 'tip:new'`, u.userID).Scan(&action); err != nil {
			t.Fatal(err)
		}
		if action != nil {
			t.Errorf("tip action = %q, want NULL", *action)
		}
		var amount int64
		if err := pool.QueryRow(ctx, `SELECT (action->>'amount_minor')::bigint FROM insights WHERE user_id = $1 AND fingerprint = 'budget:new'`, u.userID).Scan(&amount); err != nil {
			t.Fatal(err)
		}
		if amount != 20000 {
			t.Errorf("budget amount = %d", amount)
		}
		var summary string
		if err := pool.QueryRow(ctx, `SELECT summary FROM insight_memory WHERE user_id = $1`, u.userID).Scan(&summary); err != nil {
			t.Fatal(err)
		}
		if summary != "New summary." {
			t.Errorf("memory = %q", summary)
		}
	})

	t.Run("replaces the open cards", func(t *testing.T) {
		u := seedRunUser(t, pool, "replaces@example.com", true)
		addCard(t, pool, u, "open", "tip:stale", 1)
		addCard(t, pool, u, "accepted", "tip:accepted", 1)
		addCard(t, pool, u, "dismissed", "tip:dismissed", 1)

		fake := &fakeAI{respond: func(DailyInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("tip:fresh")}, Summary: "s"}, nil
		}}
		if err := Run(ctx, pool, fake, today); err != nil {
			t.Fatalf("Run: %v", err)
		}
		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"tip:fresh"}) {
			t.Errorf("open cards = %v", got)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1 AND status <> 'open'`, u.userID); n != 2 {
			t.Errorf("accepted and dismissed cards = %d, want 2", n)
		}
		// A late PATCH of the stale card is then ignored, not rejected.
		if n := countRows(t, pool, `SELECT count(*) FROM deleted_records WHERE table_name = 'insights' AND user_id = $1`, u.userID); n != 1 {
			t.Errorf("tombstones = %d, want 1 for the stale card", n)
		}
	})

	t.Run("keeps the saved summary when the new one is blank", func(t *testing.T) {
		u := seedRunUser(t, pool, "blank-summary@example.com", true)
		execSQL(t, pool, `INSERT INTO insight_memory (user_id, summary) VALUES ($1, 'Eats out a lot.')`, u.userID)
		fake := &fakeAI{respond: func(DailyInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("tip:x")}, Summary: "  "}, nil
		}}
		if err := Run(ctx, pool, fake, today); err != nil {
			t.Fatalf("Run: %v", err)
		}
		var summary string
		if err := pool.QueryRow(ctx, `SELECT summary FROM insight_memory WHERE user_id = $1`, u.userID).Scan(&summary); err != nil {
			t.Fatal(err)
		}
		if summary != "Eats out a lot." {
			t.Errorf("memory = %q, want the saved summary", summary)
		}
	})

	t.Run("skips a user who is not opted in", func(t *testing.T) {
		u := seedRunUser(t, pool, "skips@example.com", false)
		fake := &fakeAI{respond: func(DailyInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("tip:x")}, Summary: "s"}, nil
		}}
		if err := Run(ctx, pool, fake, today); err != nil {
			t.Fatalf("Run: %v", err)
		}
		if fake.calls() != 0 {
			t.Errorf("gateway calls = %d, want 0", fake.calls())
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1`, u.userID); n != 0 {
			t.Errorf("cards = %d, want 0", n)
		}
	})

	t.Run("drops an invalid card", func(t *testing.T) {
		u := seedRunUser(t, pool, "drops@example.com", true)
		var archivedID string
		if err := pool.QueryRow(ctx,
			`UPDATE categories SET archived_at = now()
			 WHERE id = (SELECT id FROM categories WHERE user_id = $1 AND type = 'expense' ORDER BY sort_order DESC LIMIT 1)
			 RETURNING id::text`, u.userID).Scan(&archivedID); err != nil {
			t.Fatal(err)
		}
		fake := &fakeAI{respond: func(DailyInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{
				budgetCard("budget:archived", archivedID, 10000),
				budgetCard("budget:ok", u.expenseCatID, 10000),
				tipCard("tip:ok"),
			}, Summary: "s"}, nil
		}}
		if err := Run(ctx, pool, fake, today); err != nil {
			t.Fatalf("Run: %v", err)
		}
		if got := openFingerprints(t, pool, u.userID); !slices.Equal(got, []string{"budget:ok", "tip:ok"}) {
			t.Errorf("open cards = %v", got)
		}
	})

	t.Run("deletes cards and questions older than 60 days", func(t *testing.T) {
		u := seedRunUser(t, pool, "prunes@example.com", true)
		addCard(t, pool, u, "accepted", "tip:61", 61)
		addCard(t, pool, u, "accepted", "tip:59", 59)
		for _, age := range []int{61, 59} {
			execSQL(t, pool,
				`INSERT INTO insight_questions (id, user_id, category_id, question, answer, status, answered_at, created_at, updated_at)
				 VALUES (gen_random_uuid(), $1, $2, $3, 'An answer.', 'answered',
				         now() - make_interval(days => $4), now() - make_interval(days => $4), now() - make_interval(days => $4))`,
				u.userID, u.expenseCatID, fmt.Sprintf("Question %d?", age), age)
		}
		fake := &fakeAI{respond: func(DailyInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{Summary: "s"}, nil
		}}
		if err := Run(ctx, pool, fake, today); err != nil {
			t.Fatalf("Run: %v", err)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1 AND fingerprint = 'tip:61'`, u.userID); n != 0 {
			t.Errorf("61-day-old card is still there")
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insights WHERE user_id = $1 AND fingerprint = 'tip:59'`, u.userID); n != 1 {
			t.Errorf("59-day-old card is gone")
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insight_questions WHERE user_id = $1 AND question = 'Question 61?'`, u.userID); n != 0 {
			t.Errorf("61-day-old question is still there")
		}
		if n := countRows(t, pool, `SELECT count(*) FROM insight_questions WHERE user_id = $1 AND question = 'Question 59?'`, u.userID); n != 1 {
			t.Errorf("59-day-old question is gone")
		}
		for _, table := range []string{"insights", "insight_questions"} {
			if n := countRows(t, pool, `SELECT count(*) FROM deleted_records WHERE table_name = $1 AND user_id = $2`, table, u.userID); n != 1 {
				t.Errorf("%s tombstones = %d, want 1", table, n)
			}
		}
	})

	t.Run("an auth error stops the run", func(t *testing.T) {
		a := seedRunUser(t, pool, "auth-a@example.com", true)
		b := seedRunUser(t, pool, "auth-b@example.com", true)
		execSQL(t, pool, `UPDATE user_settings SET insights_enabled = true WHERE user_id IN ($1, $2)`, a.userID, b.userID)

		fake := &fakeAI{respond: func(DailyInput) (aiclient.DailyInsightsResult, error) {
			return aiclient.DailyInsightsResult{}, fmt.Errorf("call: %w", aiclient.ErrAuth)
		}}
		err := Run(ctx, pool, fake, today)
		if !errors.Is(err, aiclient.ErrAuth) {
			t.Fatalf("Run = %v, want ErrAuth", err)
		}
		if fake.calls() != 1 {
			t.Errorf("gateway calls = %d, want 1", fake.calls())
		}
	})

	t.Run("another error skips one user", func(t *testing.T) {
		a := seedRunUser(t, pool, "skip-a@example.com", true)
		b := seedRunUser(t, pool, "skip-b@example.com", true)
		execSQL(t, pool, `UPDATE user_settings SET insights_enabled = true WHERE user_id IN ($1, $2)`, a.userID, b.userID)
		addCard(t, pool, a, "open", "tip:a-old", 1)

		fake := &fakeAI{respond: func(in DailyInput) (aiclient.DailyInsightsResult, error) {
			if owns(in, a.expenseCatID) {
				return aiclient.DailyInsightsResult{}, fmt.Errorf("call: %w", aiclient.ErrTimeout)
			}
			return aiclient.DailyInsightsResult{Cards: []aiclient.Card{tipCard("tip:b-new")}, Summary: "s"}, nil
		}}
		if err := Run(ctx, pool, fake, today); err == nil {
			t.Fatal("Run = nil, want an error")
		}
		if fake.calls() != 2 {
			t.Errorf("gateway calls = %d, want 2", fake.calls())
		}
		if got := openFingerprints(t, pool, a.userID); !slices.Equal(got, []string{"tip:a-old"}) {
			t.Errorf("user A open cards = %v", got)
		}
		if got := openFingerprints(t, pool, b.userID); !slices.Equal(got, []string{"tip:b-new"}) {
			t.Errorf("user B open cards = %v", got)
		}
	})
}

func TestLimitSummary(t *testing.T) {
	short := strings.Repeat("ä", maxSummaryLen)
	if got := limitSummary(short); got != short {
		t.Fatalf("summary of %d characters changed", maxSummaryLen)
	}
	long := strings.Repeat("ä", maxSummaryLen+5)
	if got := limitSummary(long); got != short {
		t.Fatalf("summary of %d characters cut to %d characters, want %d",
			maxSummaryLen+5, len([]rune(got)), maxSummaryLen)
	}
}
