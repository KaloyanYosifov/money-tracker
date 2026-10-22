package sync_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/schema"
	"github.com/KaloyanYosifov/money-tracker/api/internal/sync"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

// raceWithDelete applies a DELETE of id in one open transaction, then starts
// op in a second transaction, which blocks on the row lock. It commits the
// DELETE first and returns the result of op after its commit.
func raceWithDelete(t *testing.T, pool *pgxpool.Pool, userID, table, id string, op schema.UploadOp) sync.Result {
	t.Helper()
	ctx := context.Background()

	delTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = delTx.Rollback(ctx) }()
	res, err := sync.ApplyOp(ctx, delTx, userID, del(table, id))
	if err != nil {
		t.Fatal(err)
	}
	wantStatus(t, res, sync.Applied, "")

	type outcome struct {
		res sync.Result
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			done <- outcome{err: err}
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		res, err := sync.ApplyOp(ctx, tx, userID, op)
		if err == nil {
			err = tx.Commit(ctx)
		}
		done <- outcome{res, err}
	}()

	// Wait until the second transaction waits for the lock of the DELETE.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		err := pool.QueryRow(ctx,
			`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`).
			Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the second op did not wait for the DELETE")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := delTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	out := <-done
	if out.err != nil {
		t.Fatal(out.err)
	}
	return out.res
}

func TestApplyDeleteWinsConcurrent(t *testing.T) {
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")

	t.Run("put_during_delete_is_ignored", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 300))), sync.Applied, "")
		res := raceWithDelete(t, pool, a.userID, "transactions", id, put("transactions", id, expense(t, a, 400)))
		wantStatus(t, res, sync.Ignored, "")
		if n := rowCount(t, pool, `SELECT count(*) FROM transactions WHERE id = $1`, id); n != 0 {
			t.Errorf("rows = %d, want 0: the deleted record came back", n)
		}
	})

	t.Run("patch_during_delete_is_ignored", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 300))), sync.Applied, "")
		res := raceWithDelete(t, pool, a.userID, "transactions", id, patch("transactions", id, data(t, `{"amount_minor":500}`)))
		wantStatus(t, res, sync.Ignored, "")
	})

	t.Run("patch_account_during_delete_is_ignored", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("accounts", id, data(t,
			`{"user_id":%q,"name":"Cash","color":"#112233","sort_order":9}`, a.userID))), sync.Applied, "")
		res := raceWithDelete(t, pool, a.userID, "accounts", id, patch("accounts", id, data(t, `{"name":"Cash 2"}`)))
		wantStatus(t, res, sync.Ignored, "")
	})
}

func TestApplyRecurringOccurrenceKeepsEdits(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")
	b := seedUser(t, pool, "b@example.com")

	occurrence := func(f fixture, amount int) schema.UploadOpData {
		return data(t, `{"user_id":%q,"type":"expense","amount_minor":%d,"currency_code":"EUR","date":"2026-10-20",
			"name":"Rent","category_id":%q,"account_id":%q,"note":null,"source":"recurring"}`,
			f.userID, amount, f.expenseCatID, f.accountID)
	}

	// Device B generates the occurrence and the user edits it.
	id := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("transactions", id, occurrence(a, 1000))), sync.Applied, "")
	wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"amount_minor":1234}`))), sync.Applied, "")

	// Device A generates the same occurrence ID before it downloads the edit.
	wantStatus(t, apply(t, pool, a.userID, put("transactions", id, occurrence(a, 1000))), sync.Applied, "")

	var amount int64
	if err := pool.QueryRow(ctx, `SELECT amount_minor FROM transactions WHERE id = $1`, id).Scan(&amount); err != nil {
		t.Fatal(err)
	}
	if amount != 1234 {
		t.Errorf("amount_minor = %d, want 1234: a second PUT of the occurrence overwrote the edit", amount)
	}

	// The occurrence of another user stays forbidden.
	wantStatus(t, apply(t, pool, b.userID, put("transactions", id, occurrence(b, 1000))), sync.Rejected, "forbidden")
}

func TestApplyCategoryTypeChangeInUse(t *testing.T) {
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")

	cat := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("categories", cat, data(t,
		`{"user_id":%q,"type":"expense","name":"Pets","icon":"tag","color":"#112233","sort_order":50}`, a.userID))), sync.Applied, "")

	// A category without records can change its type.
	wantStatus(t, apply(t, pool, a.userID, patch("categories", cat, data(t, `{"type":"income"}`))), sync.Applied, "")
	wantStatus(t, apply(t, pool, a.userID, patch("categories", cat, data(t, `{"type":"expense"}`))), sync.Applied, "")

	d := expense(t, a, 100)
	d["category_id"] = cat
	wantStatus(t, apply(t, pool, a.userID, put("transactions", newID(t, pool), d)), sync.Applied, "")

	wantStatus(t, apply(t, pool, a.userID, patch("categories", cat, data(t, `{"type":"income"}`))), sync.Rejected, "invalid_category_type")
	wantStatus(t, apply(t, pool, a.userID, put("categories", cat, data(t,
		`{"user_id":%q,"type":"income","name":"Pets","icon":"tag","color":"#112233","sort_order":50}`, a.userID))), sync.Rejected, "invalid_category_type")
	// The same type and other fields still work.
	wantStatus(t, apply(t, pool, a.userID, patch("categories", cat, data(t, `{"type":"expense","name":"Pet food"}`))), sync.Applied, "")
}
