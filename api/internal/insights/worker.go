package insights

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// QuestionInput is the data that the category_question task gets. Amounts
// are minor units. Dates are YYYY-MM-DD.
type QuestionInput struct {
	Today           string             `json:"today"`
	CurrencyCode    string             `json:"currency_code"`
	Summary         string             `json:"summary"`
	Question        string             `json:"question"`
	Category        InputCategory      `json:"category"`
	Budget          *InputBudget       `json:"budget"`
	Accounts        []InputAccount     `json:"accounts"`
	RecurringRules  []InputRule        `json:"recurring_rules"`
	Transactions    []InputTransaction `json:"transactions"`
	RecentQuestions []InputQA          `json:"recent_questions"`
}

// InputQA is an earlier answered question of the user.
type InputQA struct {
	CategoryID string `json:"category_id"`
	Question   string `json:"question"`
	Answer     string `json:"answer"`
}

const (
	// questionBatch is the most questions that one pass answers.
	questionBatch = 10
	// questionMaxAge is how long a question can stay pending.
	questionMaxAge = 24 * time.Hour
	// recentQuestions is how many earlier answers the gateway gets.
	recentQuestions = 5
	// maxAnswerLen is the answer limit of insight_question.schema.json.
	maxAnswerLen = 2000
	// dailyQuestionLimit is the most questions of a user that the worker
	// answers in 24 hours. The app has the same limit (DAILY_QUESTION_LIMIT).
	dailyQuestionLimit = 50

	errTextUnavailable = "AI is not available now. Try again later."
	errTextNoCategory  = "Category not found"
	errTextDisabled    = "AI Insights is turned off."
	errTextDailyLimit  = "You can ask 50 questions a day. Try again later."
)

// retryDelays are the waits after the first and the second failed attempt.
// The attempt after the last delay is the last one.
var retryDelays = []time.Duration{time.Minute, 5 * time.Minute}

// querier is the read part of a pool or a transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// execer is the write part of a pool or a transaction.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// RunWorker answers pending questions every interval until ctx is done.
func RunWorker(ctx context.Context, pool *pgxpool.Pool, client AIClient, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := processPending(ctx, pool, client, time.Now()); err != nil && ctx.Err() == nil {
			slog.Error("insights question worker pass failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// processPending answers the pending questions that are due at now, up to
// questionBatch of them. Each question has its own transaction, and its row
// stays locked (FOR UPDATE SKIP LOCKED) during the gateway call, so that two
// workers do not answer the same question.
func processPending(ctx context.Context, pool *pgxpool.Pool, client AIClient, now time.Time) error {
	for range questionBatch {
		found, err := processOne(ctx, pool, client, now)
		if err != nil || !found {
			return err
		}
	}
	return nil
}

// pendingQuestion is a locked pending row.
type pendingQuestion struct {
	id, userID, categoryID, question string
	createdAt                        time.Time
	attempts, answeredToday          int
	archived, enabled                bool
}

// processOne locks and handles one due question. It returns false when no
// question is due. A question of a user who turned AI Insights off fails
// without a gateway call, and so does a question over the daily limit. If the data of a question cannot be read, the
// question gets a failed attempt, so that it does not block the queue.
func processOne(ctx context.Context, pool *pgxpool.Pool, client AIClient, now time.Time) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var q pendingQuestion
	err = tx.QueryRow(ctx,
		`SELECT q.id::text, q.user_id::text, q.category_id::text, q.question, q.created_at, q.attempts,
		        c.archived_at IS NOT NULL, s.insights_enabled,
		        (SELECT count(*) FROM insight_questions a
		         WHERE a.user_id = q.user_id AND a.answered_at > $1::timestamptz - interval '24 hours')
		 FROM insight_questions q
		 JOIN categories c ON c.user_id = q.user_id AND c.id = q.category_id
		 JOIN user_settings s ON s.user_id = q.user_id
		 WHERE q.status = 'pending' AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= $1)
		 ORDER BY q.created_at
		 LIMIT 1
		 FOR UPDATE OF q SKIP LOCKED`, now).
		Scan(&q.id, &q.userID, &q.categoryID, &q.question, &q.createdAt, &q.attempts, &q.archived, &q.enabled, &q.answeredToday)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("select pending question: %w", err)
	}

	switch {
	case now.Sub(q.createdAt) > questionMaxAge:
		err = failQuestion(ctx, tx, q.id, q.attempts, errTextUnavailable, now)
	case !q.enabled:
		err = failQuestion(ctx, tx, q.id, q.attempts, errTextDisabled, now)
	case q.archived:
		err = failQuestion(ctx, tx, q.id, q.attempts, errTextNoCategory, now)
	case q.answeredToday >= dailyQuestionLimit:
		err = failQuestion(ctx, tx, q.id, q.attempts, errTextDailyLimit, now)
	default:
		err = askQuestion(ctx, tx, client, q, now)
		if err != nil && ctx.Err() == nil {
			// The transaction can be aborted, so count the attempt outside it.
			slog.Error("insights question failed", "question_id", q.id, "user_id", q.userID, "err", err)
			_ = tx.Rollback(ctx)
			return true, countAttempt(ctx, pool, q, now)
		}
	}
	if err != nil {
		return true, err
	}
	if err := tx.Commit(ctx); err != nil {
		return true, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

// askQuestion calls the gateway and writes the answer, or counts a failed
// attempt.
func askQuestion(ctx context.Context, tx pgx.Tx, client AIClient, q pendingQuestion, now time.Time) error {
	input, data, err := readQuestionData(ctx, tx, q, now)
	if err != nil {
		return err
	}
	if input.Summary, err = readMemory(ctx, tx, q.userID); err != nil {
		return err
	}

	result, err := client.CategoryQuestion(ctx, input)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err == nil {
		if strings.TrimSpace(result.Answer) == "" || utf8.RuneCountInString(result.Answer) > maxAnswerLen {
			err = fmt.Errorf("answer is empty or longer than %d characters", maxAnswerLen)
		}
	}
	if err != nil {
		slog.Warn("insights question attempt failed", "question_id", q.id, "user_id", q.userID, "attempt", q.attempts+1, "err", err)
		return countAttempt(ctx, tx, q, now)
	}

	var action *string
	if err := CheckAnswerAction(result.Action, data); err != nil {
		slog.Warn("insights answer action dropped", "question_id", q.id, "user_id", q.userID, "err", err)
	} else if !isNull(result.Action) {
		s := string(result.Action)
		action = &s
	}
	_, err = tx.Exec(ctx,
		`UPDATE insight_questions
		 SET status = 'answered', answer = $2, action = $3::jsonb, error = NULL, answered_at = $4,
		     attempts = $5, next_attempt_at = NULL, updated_at = $4
		 WHERE id = $1`,
		q.id, result.Answer, action, now, q.attempts+1)
	if err != nil {
		return fmt.Errorf("write answer: %w", err)
	}
	return nil
}

// countAttempt counts a failed attempt of q. It sets the time of the next
// attempt, or sets the question failed after the last attempt.
func countAttempt(ctx context.Context, db execer, q pendingQuestion, now time.Time) error {
	attempts := q.attempts + 1
	if attempts > len(retryDelays) {
		return failQuestion(ctx, db, q.id, attempts, errTextUnavailable, now)
	}
	_, err := db.Exec(ctx,
		`UPDATE insight_questions SET attempts = $2, next_attempt_at = $3, updated_at = $4
		 WHERE id = $1 AND status = 'pending'`,
		q.id, attempts, now.Add(retryDelays[attempts-1]), now)
	if err != nil {
		return fmt.Errorf("count attempt: %w", err)
	}
	return nil
}

// failQuestion sets the question failed with the text that the app shows.
func failQuestion(ctx context.Context, db execer, id string, attempts int, text string, now time.Time) error {
	_, err := db.Exec(ctx,
		`UPDATE insight_questions
		 SET status = 'failed', error = $2, attempts = $3, next_attempt_at = NULL, updated_at = $4
		 WHERE id = $1 AND status = 'pending'`, id, text, attempts, now)
	if err != nil {
		return fmt.Errorf("fail question: %w", err)
	}
	return nil
}

// readQuestionData builds the gateway input for q without the summary, and
// the UserData that the action check needs.
func readQuestionData(ctx context.Context, db querier, q pendingQuestion, now time.Time) (QuestionInput, UserData, error) {
	today := now.Format(time.DateOnly)
	in := QuestionInput{Today: today, Question: q.question}
	var data UserData

	err := db.QueryRow(ctx, `SELECT currency_code FROM user_settings WHERE user_id = $1`, q.userID).Scan(&in.CurrencyCode)
	if err != nil {
		return in, data, fmt.Errorf("read settings: %w", err)
	}

	rows, err := db.Query(ctx,
		`SELECT id::text, type, name, archived_at IS NOT NULL FROM categories
		 WHERE user_id = $1 ORDER BY sort_order`, q.userID)
	if err != nil {
		return in, data, fmt.Errorf("read categories: %w", err)
	}
	categories, err := pgx.CollectRows(rows, pgx.RowToStructByPos[InputCategory])
	if err != nil {
		return in, data, fmt.Errorf("read categories: %w", err)
	}
	for _, c := range categories {
		data.Categories = append(data.Categories, Category{ID: c.ID, Type: c.Type, Archived: c.Archived})
		if c.ID == q.categoryID {
			in.Category = c
		}
	}

	rows, err = db.Query(ctx,
		`SELECT category_id::text, period, amount_minor FROM budgets
		 WHERE user_id = $1 AND category_id IS NOT NULL`, q.userID)
	if err != nil {
		return in, data, fmt.Errorf("read budgets: %w", err)
	}
	budgets, err := pgx.CollectRows(rows, pgx.RowToStructByPos[InputBudget])
	if err != nil {
		return in, data, fmt.Errorf("read budgets: %w", err)
	}
	for _, b := range budgets {
		data.Budgets = append(data.Budgets, CategoryBudget{CategoryID: *b.CategoryID, AmountMinor: b.AmountMinor})
		if *b.CategoryID == q.categoryID {
			in.Budget = &b
		}
	}

	rows, err = db.Query(ctx,
		`SELECT id::text, name, archived_at IS NOT NULL FROM accounts
		 WHERE user_id = $1 ORDER BY sort_order`, q.userID)
	if err != nil {
		return in, data, fmt.Errorf("read accounts: %w", err)
	}
	if in.Accounts, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputAccount]); err != nil {
		return in, data, fmt.Errorf("read accounts: %w", err)
	}

	rows, err = db.Query(ctx,
		`SELECT id::text, type, amount_minor, name, category_id::text, account_id::text, to_account_id::text,
		        frequency, start_date::text, end_date::text
		 FROM recurring_rules WHERE user_id = $1 AND category_id = $2 ORDER BY start_date, id`,
		q.userID, q.categoryID)
	if err != nil {
		return in, data, fmt.Errorf("read recurring rules: %w", err)
	}
	if in.RecurringRules, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputRule]); err != nil {
		return in, data, fmt.Errorf("read recurring rules: %w", err)
	}

	rows, err = db.Query(ctx,
		`SELECT type, amount_minor, date::text, name, category_id::text, account_id::text, to_account_id::text,
		        note, recurring_rule_id::text
		 FROM transactions
		 WHERE user_id = $1 AND category_id = $2 AND date > $3::date - $4::int AND date <= $3::date
		 ORDER BY date, created_at`, q.userID, q.categoryID, today, historyDays)
	if err != nil {
		return in, data, fmt.Errorf("read transactions: %w", err)
	}
	if in.Transactions, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputTransaction]); err != nil {
		return in, data, fmt.Errorf("read transactions: %w", err)
	}

	rows, err = db.Query(ctx,
		`SELECT category_id::text, question, answer FROM insight_questions
		 WHERE user_id = $1 AND status = 'answered' AND answer IS NOT NULL
		 ORDER BY answered_at DESC LIMIT $2`, q.userID, recentQuestions)
	if err != nil {
		return in, data, fmt.Errorf("read recent questions: %w", err)
	}
	if in.RecentQuestions, err = pgx.CollectRows(rows, pgx.RowToStructByPos[InputQA]); err != nil {
		return in, data, fmt.Errorf("read recent questions: %w", err)
	}
	return in, data, nil
}
