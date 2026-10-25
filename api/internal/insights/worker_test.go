package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	gosync "sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

// questionAI is the gateway for the worker tests. respond answers each
// category_question call.
type questionAI struct {
	mu      gosync.Mutex
	inputs  []QuestionInput
	respond func(in QuestionInput) (aiclient.CategoryQuestionResult, error)
}

func (f *questionAI) DailyInsights(context.Context, any) (aiclient.DailyInsightsResult, error) {
	return aiclient.DailyInsightsResult{}, errors.New("not used in the worker tests")
}

func (f *questionAI) CategoryQuestion(_ context.Context, input any) (aiclient.CategoryQuestionResult, error) {
	in, ok := input.(QuestionInput)
	if !ok {
		return aiclient.CategoryQuestionResult{}, fmt.Errorf("input is %T, not QuestionInput", input)
	}
	f.mu.Lock()
	f.inputs = append(f.inputs, in)
	f.mu.Unlock()
	return f.respond(in)
}

func (f *questionAI) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.inputs)
}

func answer(text, action string) func(QuestionInput) (aiclient.CategoryQuestionResult, error) {
	return func(QuestionInput) (aiclient.CategoryQuestionResult, error) {
		return aiclient.CategoryQuestionResult{Answer: text, Action: json.RawMessage(action)}, nil
	}
}

// addQuestion inserts a question for u about categoryID and returns its id.
func addQuestion(t *testing.T, pool *pgxpool.Pool, u runUser, categoryID, question, status string, created time.Time) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO insight_questions (id, user_id, category_id, question, status, created_at, updated_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $5) RETURNING id::text`,
		u.userID, categoryID, question, status, created).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// questionRow is the server-written state of one question.
type questionRow struct {
	Status        string
	Answer        *string
	Action        *string
	Error         *string
	AnsweredAt    *time.Time
	Attempts      int
	NextAttemptAt *time.Time
}

func readQuestion(t *testing.T, pool *pgxpool.Pool, id string) questionRow {
	t.Helper()
	var r questionRow
	err := pool.QueryRow(context.Background(),
		`SELECT status, answer, action::text, error, answered_at, attempts, next_attempt_at
		 FROM insight_questions WHERE id = $1`, id).
		Scan(&r.Status, &r.Answer, &r.Action, &r.Error, &r.AnsweredAt, &r.Attempts, &r.NextAttemptAt)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestWorkerProcessPending(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	now := time.Now().UTC().Truncate(time.Second)

	// A subtest that fails half-way must not leave pending rows for the next.
	clean := func(t *testing.T) {
		t.Cleanup(func() { execSQL(t, pool, `DELETE FROM insight_questions WHERE status = 'pending'`) })
	}

	t.Run("answers a pending question", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "answers@example.com", true)
		execSQL(t, pool,
			`INSERT INTO transactions (id, user_id, type, amount_minor, currency_code, date, name, category_id, account_id, source)
			 VALUES (gen_random_uuid(), $1, 'expense', 1250, 'EUR', $2, 'Lunch', $3, $4, 'manual')`,
			u.userID, now.AddDate(0, 0, -3).Format(time.DateOnly), u.expenseCatID, u.accountID)
		execSQL(t, pool,
			`INSERT INTO budgets (id, user_id, category_id, period, amount_minor)
			 VALUES (gen_random_uuid(), $1, $2, 'monthly', 30000)`, u.userID, u.expenseCatID)
		execSQL(t, pool, `INSERT INTO insight_memory (user_id, summary) VALUES ($1, 'Eats out a lot.')`, u.userID)
		for i := range 6 {
			execSQL(t, pool,
				`INSERT INTO insight_questions (id, user_id, category_id, question, answer, status, answered_at, created_at, updated_at)
				 VALUES (gen_random_uuid(), $1, $2, $3, 'Old answer', 'answered', $4, $4, $4)`,
				u.userID, u.expenseCatID, fmt.Sprintf("Old question %d", i), now.Add(-time.Duration(10-i)*time.Hour))
		}
		id := addQuestion(t, pool, u, u.expenseCatID, "Why so much on food?", "pending", now.Add(-time.Minute))

		fake := &questionAI{respond: answer("You eat out often.", "null")}
		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("processPending: %v", err)
		}

		if fake.calls() != 1 {
			t.Fatalf("gateway calls = %d, want 1", fake.calls())
		}
		in := fake.inputs[0]
		if in.Question != "Why so much on food?" || in.Category.ID != u.expenseCatID || in.CurrencyCode != "EUR" {
			t.Errorf("question, category, currency = %q, %q, %q", in.Question, in.Category.ID, in.CurrencyCode)
		}
		if len(in.Transactions) != 1 || in.Budget == nil || in.Budget.AmountMinor != 30000 {
			t.Errorf("transactions = %d, budget = %+v", len(in.Transactions), in.Budget)
		}
		if in.Summary != "Eats out a lot." {
			t.Errorf("summary = %q", in.Summary)
		}
		if len(in.RecentQuestions) != 5 || in.RecentQuestions[0].Question != "Old question 5" {
			t.Errorf("recent questions = %+v, want the last five, newest first", in.RecentQuestions)
		}

		r := readQuestion(t, pool, id)
		if r.Status != "answered" || r.Answer == nil || *r.Answer != "You eat out often." || r.AnsweredAt == nil || r.Action != nil {
			t.Errorf("row = %+v", r)
		}
	})

	t.Run("writes a valid action", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "action@example.com", true)
		valid := addQuestion(t, pool, u, u.expenseCatID, "valid", "pending", now.Add(-2*time.Minute))
		invalid := addQuestion(t, pool, u, u.expenseCatID, "invalid", "pending", now.Add(-time.Minute))

		fake := &questionAI{respond: func(in QuestionInput) (aiclient.CategoryQuestionResult, error) {
			// A budget for an income category is invalid.
			cat := u.expenseCatID
			if in.Question == "invalid" {
				cat = u.incomeCatID
			}
			return aiclient.CategoryQuestionResult{
				Answer: "Set a budget.",
				Action: json.RawMessage(fmt.Sprintf(`{"category_id":%q,"amount_minor":20000}`, cat)),
			}, nil
		}}
		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("processPending: %v", err)
		}

		r := readQuestion(t, pool, valid)
		if r.Status != "answered" || r.Action == nil {
			t.Fatalf("valid row = %+v", r)
		}
		var got BudgetAction
		if err := json.Unmarshal([]byte(*r.Action), &got); err != nil || got.CategoryID != u.expenseCatID || got.AmountMinor != 20000 {
			t.Errorf("action = %s (%v)", *r.Action, err)
		}
		r = readQuestion(t, pool, invalid)
		if r.Status != "answered" || r.Answer == nil || *r.Answer != "Set a budget." || r.Action != nil {
			t.Errorf("invalid row = %+v, want answered with no action", r)
		}
	})

	t.Run("two workers do not double-answer", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "twice@example.com", true)
		id := addQuestion(t, pool, u, u.expenseCatID, "once", "pending", now)

		fake := &questionAI{respond: func(QuestionInput) (aiclient.CategoryQuestionResult, error) {
			time.Sleep(200 * time.Millisecond)
			return aiclient.CategoryQuestionResult{Answer: "Once."}, nil
		}}
		var wg gosync.WaitGroup
		errs := make([]error, 2)
		for i := range 2 {
			wg.Go(func() { errs[i] = processPending(ctx, pool, fake, now) })
		}
		wg.Wait()
		for _, err := range errs {
			if err != nil {
				t.Fatalf("processPending: %v", err)
			}
		}
		if fake.calls() != 1 {
			t.Errorf("gateway calls = %d, want 1", fake.calls())
		}
		if r := readQuestion(t, pool, id); r.Status != "answered" {
			t.Errorf("status = %q", r.Status)
		}
	})

	t.Run("retry then fail", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "retry@example.com", true)
		id := addQuestion(t, pool, u, u.expenseCatID, "retry", "pending", now)
		fake := &questionAI{respond: func(QuestionInput) (aiclient.CategoryQuestionResult, error) {
			return aiclient.CategoryQuestionResult{}, fmt.Errorf("call: %w", aiclient.ErrTimeout)
		}}

		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("pass 1: %v", err)
		}
		r := readQuestion(t, pool, id)
		if r.Status != "pending" || r.Attempts != 1 || r.NextAttemptAt == nil || !r.NextAttemptAt.Equal(now.Add(time.Minute)) {
			t.Fatalf("after pass 1: %+v", r)
		}

		// Not due yet: no call.
		if err := processPending(ctx, pool, fake, now.Add(30*time.Second)); err != nil {
			t.Fatal(err)
		}
		if fake.calls() != 1 {
			t.Fatalf("gateway calls before due = %d, want 1", fake.calls())
		}

		second := now.Add(time.Minute)
		if err := processPending(ctx, pool, fake, second); err != nil {
			t.Fatalf("pass 2: %v", err)
		}
		r = readQuestion(t, pool, id)
		if r.Status != "pending" || r.Attempts != 2 || r.NextAttemptAt == nil || !r.NextAttemptAt.Equal(second.Add(5*time.Minute)) {
			t.Fatalf("after pass 2: %+v", r)
		}

		if err := processPending(ctx, pool, fake, second.Add(5*time.Minute)); err != nil {
			t.Fatalf("pass 3: %v", err)
		}
		r = readQuestion(t, pool, id)
		if r.Status != "failed" || r.Attempts != 3 || r.Error == nil || *r.Error != errTextUnavailable {
			t.Fatalf("after pass 3: %+v", r)
		}
		if fake.calls() != 3 {
			t.Errorf("gateway calls = %d, want 3", fake.calls())
		}
	})

	t.Run("a 24-hour-old pending question fails", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "old@example.com", true)
		id := addQuestion(t, pool, u, u.expenseCatID, "old", "pending", now.Add(-25*time.Hour))
		fake := &questionAI{respond: answer("Late.", "null")}

		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("processPending: %v", err)
		}
		r := readQuestion(t, pool, id)
		if r.Status != "failed" || r.Error == nil || *r.Error != "AI is not available now. Try again later." {
			t.Errorf("row = %+v", r)
		}
		if fake.calls() != 0 {
			t.Errorf("gateway calls = %d, want 0", fake.calls())
		}
	})

	t.Run("a question over the daily limit fails", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "limit@example.com", true)
		answeredAt := func(ago time.Duration, n int) {
			execSQL(t, pool,
				`INSERT INTO insight_questions (id, user_id, category_id, question, answer, status, answered_at, created_at, updated_at)
				 SELECT gen_random_uuid(), $1, $2, 'q', 'a', 'answered', $3, $3, $3 FROM generate_series(1, $4)`,
				u.userID, u.expenseCatID, now.Add(-ago), n)
		}
		answeredAt(25*time.Hour, 10)
		answeredAt(time.Hour, dailyQuestionLimit-1)
		under := addQuestion(t, pool, u, u.expenseCatID, "under", "pending", now.Add(-2*time.Minute))
		over := addQuestion(t, pool, u, u.expenseCatID, "over", "pending", now.Add(-time.Minute))
		fake := &questionAI{respond: answer("Yes.", "null")}

		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("processPending: %v", err)
		}
		if r := readQuestion(t, pool, under); r.Status != "answered" {
			t.Errorf("question 50 = %+v, want answered", r)
		}
		r := readQuestion(t, pool, over)
		if r.Status != "failed" || r.Error == nil || *r.Error != errTextDailyLimit {
			t.Errorf("question 51 = %+v", r)
		}
		if fake.calls() != 1 {
			t.Errorf("gateway calls = %d, want 1", fake.calls())
		}
	})

	t.Run("a question of an opted-out user fails", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "optedout@example.com", false)
		id := addQuestion(t, pool, u, u.expenseCatID, "off", "pending", now)
		fake := &questionAI{respond: answer("No.", "null")}

		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("processPending: %v", err)
		}
		r := readQuestion(t, pool, id)
		if r.Status != "failed" || r.Error == nil || *r.Error != errTextDisabled {
			t.Errorf("row = %+v", r)
		}
		if fake.calls() != 0 {
			t.Errorf("gateway calls = %d, want 0", fake.calls())
		}
	})

	t.Run("a data error counts an attempt and the pass goes on", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "dataerror@example.com", true)
		first := addQuestion(t, pool, u, u.expenseCatID, "first", "pending", now.Add(-2*time.Minute))
		second := addQuestion(t, pool, u, u.expenseCatID, "second", "pending", now.Add(-time.Minute))
		// readMemory fails while the table has another name.
		execSQL(t, pool, `ALTER TABLE insight_memory RENAME TO insight_memory_moved`)
		t.Cleanup(func() { execSQL(t, pool, `ALTER TABLE insight_memory_moved RENAME TO insight_memory`) })
		fake := &questionAI{respond: answer("No.", "null")}

		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("processPending: %v", err)
		}
		for _, id := range []string{first, second} {
			r := readQuestion(t, pool, id)
			if r.Status != "pending" || r.Attempts != 1 || r.NextAttemptAt == nil || !r.NextAttemptAt.Equal(now.Add(time.Minute)) {
				t.Errorf("row %s = %+v, want one attempt and a retry in 1 minute", id, r)
			}
		}
		if fake.calls() != 0 {
			t.Errorf("gateway calls = %d, want 0", fake.calls())
		}
	})

	t.Run("an archived category fails the question", func(t *testing.T) {
		clean(t)
		u := seedRunUser(t, pool, "archived@example.com", true)
		id := addQuestion(t, pool, u, u.expenseCatID, "archived", "pending", now)
		execSQL(t, pool, `UPDATE categories SET archived_at = now() WHERE id = $1`, u.expenseCatID)
		fake := &questionAI{respond: answer("No.", "null")}

		if err := processPending(ctx, pool, fake, now); err != nil {
			t.Fatalf("processPending: %v", err)
		}
		r := readQuestion(t, pool, id)
		if r.Status != "failed" || r.Error == nil || *r.Error != "Category not found" {
			t.Errorf("row = %+v", r)
		}
		if fake.calls() != 0 {
			t.Errorf("gateway calls = %d, want 0", fake.calls())
		}
	})
}
