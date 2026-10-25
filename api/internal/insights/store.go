package insights

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DailyInput is the data of one user that the daily_insights task gets.
// Amounts are minor units. Dates are YYYY-MM-DD.
type DailyInput struct {
	Today                 string             `json:"today"`
	CurrencyCode          string             `json:"currency_code"`
	Summary               string             `json:"summary"`
	Categories            []InputCategory    `json:"categories"`
	Accounts              []InputAccount     `json:"accounts"`
	Budgets               []InputBudget      `json:"budgets"`
	RecurringRules        []InputRule        `json:"recurring_rules"`
	Transactions          []InputTransaction `json:"transactions"`
	RecentCards           []InputCard        `json:"recent_cards"`
	DismissedFingerprints []string           `json:"dismissed_fingerprints"`
}

// InputCategory is a category in the gateway input.
type InputCategory struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
}

// InputAccount is an account in the gateway input.
type InputAccount struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
}

// InputBudget is a budget in the gateway input. A nil CategoryID is the
// overall budget.
type InputBudget struct {
	CategoryID  *string `json:"category_id"`
	Period      string  `json:"period"`
	AmountMinor int64   `json:"amount_minor"`
}

// InputRule is a recurring rule in the gateway input.
type InputRule struct {
	ID          string  `json:"id"`
	Type        string  `json:"type"`
	AmountMinor int64   `json:"amount_minor"`
	Name        string  `json:"name"`
	CategoryID  *string `json:"category_id"`
	AccountID   string  `json:"account_id"`
	ToAccountID *string `json:"to_account_id"`
	Frequency   string  `json:"frequency"`
	StartDate   string  `json:"start_date"`
	EndDate     *string `json:"end_date"`
}

// InputTransaction is a transaction in the gateway input.
type InputTransaction struct {
	Type            string  `json:"type"`
	AmountMinor     int64   `json:"amount_minor"`
	Date            string  `json:"date"`
	Name            string  `json:"name"`
	CategoryID      *string `json:"category_id"`
	AccountID       string  `json:"account_id"`
	ToAccountID     *string `json:"to_account_id"`
	Note            *string `json:"note"`
	RecurringRuleID *string `json:"recurring_rule_id"`
}

// InputCard is a card of the last 60 days in the gateway input.
type InputCard struct {
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	Fingerprint string `json:"fingerprint"`
	Status      string `json:"status"`
}

// retention is how long the daily run keeps cards and questions.
const retention = 60 * 24 * time.Hour

// historyDays is how many days of transactions the daily run sends.
const historyDays = 90

// optedInUsers returns the ids of the users with insights_enabled.
func optedInUsers(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT user_id::text FROM user_settings WHERE insights_enabled ORDER BY user_id`)
	if err != nil {
		return nil, fmt.Errorf("list opted-in users: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// readUserData builds the gateway input of one user for the day today, and
// the UserData that the card checks need.
func readUserData(ctx context.Context, pool *pgxpool.Pool, userID, today string) (DailyInput, UserData, error) {
	in := DailyInput{Today: today}
	var data UserData

	err := pool.QueryRow(ctx, `SELECT currency_code FROM user_settings WHERE user_id = $1`, userID).Scan(&in.CurrencyCode)
	if err != nil {
		return in, data, fmt.Errorf("read settings: %w", err)
	}

	rows, err := pool.Query(ctx,
		`SELECT id::text, type, name, archived_at IS NOT NULL FROM categories
		 WHERE user_id = $1 ORDER BY sort_order`, userID)
	if err != nil {
		return in, data, fmt.Errorf("read categories: %w", err)
	}
	in.Categories, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputCategory])
	if err != nil {
		return in, data, fmt.Errorf("read categories: %w", err)
	}
	for _, c := range in.Categories {
		data.Categories = append(data.Categories, Category{ID: c.ID, Type: c.Type, Archived: c.Archived})
	}

	rows, err = pool.Query(ctx,
		`SELECT id::text, name, archived_at IS NOT NULL FROM accounts
		 WHERE user_id = $1 ORDER BY sort_order`, userID)
	if err != nil {
		return in, data, fmt.Errorf("read accounts: %w", err)
	}
	in.Accounts, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputAccount])
	if err != nil {
		return in, data, fmt.Errorf("read accounts: %w", err)
	}

	rows, err = pool.Query(ctx,
		`SELECT category_id::text, period, amount_minor FROM budgets
		 WHERE user_id = $1 ORDER BY category_id NULLS FIRST`, userID)
	if err != nil {
		return in, data, fmt.Errorf("read budgets: %w", err)
	}
	in.Budgets, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputBudget])
	if err != nil {
		return in, data, fmt.Errorf("read budgets: %w", err)
	}
	for _, b := range in.Budgets {
		if b.CategoryID != nil {
			data.Budgets = append(data.Budgets, CategoryBudget{CategoryID: *b.CategoryID, AmountMinor: b.AmountMinor})
		}
	}

	rows, err = pool.Query(ctx,
		`SELECT id::text, type, amount_minor, name, category_id::text, account_id::text, to_account_id::text,
		        frequency, start_date::text, end_date::text
		 FROM recurring_rules WHERE user_id = $1 ORDER BY start_date, id`, userID)
	if err != nil {
		return in, data, fmt.Errorf("read recurring rules: %w", err)
	}
	in.RecurringRules, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputRule])
	if err != nil {
		return in, data, fmt.Errorf("read recurring rules: %w", err)
	}

	rows, err = pool.Query(ctx,
		`SELECT type, amount_minor, date::text, name, category_id::text, account_id::text, to_account_id::text,
		        note, recurring_rule_id::text
		 FROM transactions
		 WHERE user_id = $1 AND date > $2::date - $3::int AND date <= $2::date
		 ORDER BY date, created_at`, userID, today, historyDays)
	if err != nil {
		return in, data, fmt.Errorf("read transactions: %w", err)
	}
	in.Transactions, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputTransaction])
	if err != nil {
		return in, data, fmt.Errorf("read transactions: %w", err)
	}

	rows, err = pool.Query(ctx,
		`SELECT kind, title, fingerprint, status FROM insights
		 WHERE user_id = $1 ORDER BY created_at`, userID)
	if err != nil {
		return in, data, fmt.Errorf("read cards: %w", err)
	}
	in.RecentCards, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputCard])
	if err != nil {
		return in, data, fmt.Errorf("read cards: %w", err)
	}

	if in.DismissedFingerprints, err = dismissedFingerprints(ctx, pool, userID); err != nil {
		return in, data, err
	}
	if in.Summary, err = readMemory(ctx, pool, userID); err != nil {
		return in, data, err
	}
	return in, data, nil
}

// readMemory returns the saved summary of the user, or "" when there is none.
func readMemory(ctx context.Context, db querier, userID string) (string, error) {
	var summary string
	err := db.QueryRow(ctx, `SELECT summary FROM insight_memory WHERE user_id = $1`, userID).Scan(&summary)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read memory: %w", err)
	}
	return summary, nil
}

// dismissedFingerprints returns the fingerprints of the user's dismissed
// cards, so the gateway does not suggest them again.
func dismissedFingerprints(ctx context.Context, pool *pgxpool.Pool, userID string) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT DISTINCT fingerprint FROM insights
		 WHERE user_id = $1 AND status = 'dismissed' ORDER BY fingerprint`, userID)
	if err != nil {
		return nil, fmt.Errorf("read dismissed fingerprints: %w", err)
	}
	fps, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("read dismissed fingerprints: %w", err)
	}
	return fps, nil
}

// tombstoneDelete runs a DELETE ... RETURNING id, user_id on table and writes
// a deleted_records row for each deleted row. A late upload of a deleted row
// is then ignored, not rejected (see sync.ApplyOp).
func tombstoneDelete(ctx context.Context, tx pgx.Tx, table, deleteSQL string, args ...any) error {
	_, err := tx.Exec(ctx,
		`WITH d AS (`+deleteSQL+`)
		 INSERT INTO deleted_records (table_name, id, user_id)
		 SELECT '`+table+`', id, user_id FROM d
		 ON CONFLICT (table_name, id) DO NOTHING`, args...)
	return err
}

// replaceOpenCards deletes the user's open cards and inserts cards as open.
// The caller has checked the cards.
func replaceOpenCards(ctx context.Context, tx pgx.Tx, userID string, cards []Card) error {
	err := tombstoneDelete(ctx, tx, "insights",
		`DELETE FROM insights WHERE user_id = $1 AND status = 'open' RETURNING id, user_id`, userID)
	if err != nil {
		return fmt.Errorf("delete open cards: %w", err)
	}
	for _, c := range cards {
		var action *string
		if !isNull(c.Action) {
			s := string(c.Action)
			action = &s
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO insights (id, user_id, kind, title, body, fingerprint, status, action)
			 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'open', $6::jsonb)`,
			userID, c.Kind, c.Title, c.Body, c.Fingerprint, action)
		if err != nil {
			return fmt.Errorf("insert card %q: %w", c.Fingerprint, err)
		}
	}
	return nil
}

// saveMemory stores the new summary of the user.
func saveMemory(ctx context.Context, tx pgx.Tx, userID, summary string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO insight_memory (user_id, summary, updated_at) VALUES ($1, $2, now())
		 ON CONFLICT (user_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
		userID, summary)
	if err != nil {
		return fmt.Errorf("save memory: %w", err)
	}
	return nil
}

// pruneOld deletes the user's cards and finished questions that were last
// changed before before.
func pruneOld(ctx context.Context, tx pgx.Tx, userID string, before time.Time) error {
	err := tombstoneDelete(ctx, tx, "insights",
		`DELETE FROM insights WHERE user_id = $1 AND updated_at < $2 RETURNING id, user_id`, userID, before)
	if err != nil {
		return fmt.Errorf("prune cards: %w", err)
	}
	err = tombstoneDelete(ctx, tx, "insight_questions",
		`DELETE FROM insight_questions WHERE user_id = $1 AND status <> 'pending' AND updated_at < $2 RETURNING id, user_id`,
		userID, before)
	if err != nil {
		return fmt.Errorf("prune questions: %w", err)
	}
	return nil
}
