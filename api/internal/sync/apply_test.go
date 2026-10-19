package sync_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/schema"
	"github.com/KaloyanYosifov/money-tracker/api/internal/sync"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

// fixture is one seeded user with one account of each kind and one category
// of each type.
type fixture struct {
	userID, accountID, account2ID, expenseCatID, incomeCatID string
}

func seedUser(t *testing.T, pool *pgxpool.Pool, email string) fixture {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var f fixture
	err = tx.QueryRow(ctx,
		`INSERT INTO users (id, email, password_hash, role)
		 VALUES (gen_random_uuid(), $1, 'x', 'user') RETURNING id::text`, email).Scan(&f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if err := users.SeedDefaults(ctx, tx, f.userID, "EUR"); err != nil {
		t.Fatal(err)
	}
	q := func(sql string, dst *string) {
		if err := tx.QueryRow(ctx, sql, f.userID).Scan(dst); err != nil {
			t.Fatal(err)
		}
	}
	q(`SELECT id::text FROM accounts WHERE user_id = $1 AND sort_order = 0`, &f.accountID)
	q(`SELECT id::text FROM accounts WHERE user_id = $1 AND sort_order = 1`, &f.account2ID)
	q(`SELECT id::text FROM categories WHERE user_id = $1 AND type = 'expense' ORDER BY sort_order LIMIT 1`, &f.expenseCatID)
	q(`SELECT id::text FROM categories WHERE user_id = $1 AND type = 'income' ORDER BY sort_order LIMIT 1`, &f.incomeCatID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func newID(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// data decodes a JSON object with UseNumber, as the upload handler does.
func data(t *testing.T, format string, args ...any) schema.UploadOpData {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(fmt.Appendf(nil, format, args...)))
	dec.UseNumber()
	var d schema.UploadOpData
	if err := dec.Decode(&d); err != nil {
		t.Fatalf("decode %s: %v", format, err)
	}
	return d
}

// apply runs one op in its own transaction and commits it.
func apply(t *testing.T, pool *pgxpool.Pool, userID string, op schema.UploadOp) sync.Result {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	res, err := sync.ApplyOp(ctx, tx, userID, op)
	if err != nil {
		t.Fatalf("ApplyOp(%s %s %s): %v", op.Op, op.Table, op.ID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return res
}

func put(table, id string, d schema.UploadOpData) schema.UploadOp {
	return schema.UploadOp{Op: schema.UploadOpOpPUT, Table: schema.UploadOpTable(table), ID: id, Data: d}
}

func patch(table, id string, d schema.UploadOpData) schema.UploadOp {
	return schema.UploadOp{Op: schema.UploadOpOpPATCH, Table: schema.UploadOpTable(table), ID: id, Data: d}
}

func del(table, id string) schema.UploadOp {
	return schema.UploadOp{Op: schema.UploadOpOpDELETE, Table: schema.UploadOpTable(table), ID: id}
}

func expense(t *testing.T, f fixture, amount int) schema.UploadOpData {
	return data(t, `{"user_id":%q,"type":"expense","amount_minor":%d,"currency_code":"EUR","date":"2026-10-19",
		"name":"Lunch","category_id":%q,"account_id":%q,"note":null,"source":"manual"}`,
		f.userID, amount, f.expenseCatID, f.accountID)
}

func wantStatus(t *testing.T, res sync.Result, status sync.Status, code string) {
	t.Helper()
	if res.Status != status || res.Code != code {
		t.Fatalf("result = %+v, want status %v code %q", res, status, code)
	}
}

func rowCount(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestApply(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")
	b := seedUser(t, pool, "b@example.com")

	t.Run("put_inserts", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 1250))), sync.Applied, "")
		var owner string
		var amount int64
		err := pool.QueryRow(ctx, `SELECT user_id::text, amount_minor FROM transactions WHERE id = $1`, id).Scan(&owner, &amount)
		if err != nil {
			t.Fatal(err)
		}
		if owner != a.userID || amount != 1250 {
			t.Errorf("row = (%s, %d), want (%s, 1250)", owner, amount, a.userID)
		}
	})

	t.Run("put_is_idempotent", func(t *testing.T) {
		id := newID(t, pool)
		op := put("transactions", id, expense(t, a, 990))
		wantStatus(t, apply(t, pool, a.userID, op), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, op), sync.Applied, "")
		if n := rowCount(t, pool, `SELECT count(*) FROM transactions WHERE id = $1 AND amount_minor = 990`, id); n != 1 {
			t.Errorf("rows = %d, want 1", n)
		}
	})

	t.Run("put_user_id_mismatch_rejected", func(t *testing.T) {
		id := newID(t, pool)
		d := expense(t, a, 100)
		d["user_id"] = b.userID
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, d)), sync.Rejected, "forbidden")
		if n := rowCount(t, pool, `SELECT count(*) FROM transactions WHERE id = $1`, id); n != 0 {
			t.Errorf("rows = %d, want 0", n)
		}
	})

	t.Run("put_other_users_id_rejected", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, b.userID, put("transactions", id, expense(t, b, 500))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 1))), sync.Rejected, "forbidden")
		var owner string
		var amount int64
		err := pool.QueryRow(ctx, `SELECT user_id::text, amount_minor FROM transactions WHERE id = $1`, id).Scan(&owner, &amount)
		if err != nil {
			t.Fatal(err)
		}
		if owner != b.userID || amount != 500 {
			t.Errorf("B's row = (%s, %d), want (%s, 500)", owner, amount, b.userID)
		}
	})

	t.Run("patch_updates_only_sent_fields", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 700))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"name":"Dinner"}`))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"amount_minor":800}`))), sync.Applied, "")
		var name string
		var amount int64
		if err := pool.QueryRow(ctx, `SELECT name, amount_minor FROM transactions WHERE id = $1`, id).Scan(&name, &amount); err != nil {
			t.Fatal(err)
		}
		if name != "Dinner" || amount != 800 {
			t.Errorf("row = (%s, %d), want (Dinner, 800)", name, amount)
		}
	})

	t.Run("patch_same_field_last_wins", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 700))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"note":"first"}`))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"note":"second"}`))), sync.Applied, "")
		var note string
		if err := pool.QueryRow(ctx, `SELECT note FROM transactions WHERE id = $1`, id).Scan(&note); err != nil {
			t.Fatal(err)
		}
		if note != "second" {
			t.Errorf("note = %q, want second", note)
		}
	})

	t.Run("patch_missing_rejected", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"name":"x"}`))), sync.Rejected, "not_found")
	})

	t.Run("delete_removes_and_tombstones", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 300))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, del("transactions", id)), sync.Applied, "")
		if n := rowCount(t, pool, `SELECT count(*) FROM transactions WHERE id = $1`, id); n != 0 {
			t.Errorf("rows = %d, want 0", n)
		}
		n := rowCount(t, pool,
			`SELECT count(*) FROM deleted_records WHERE table_name = 'transactions' AND id = $1 AND user_id = $2`, id, a.userID)
		if n != 1 {
			t.Errorf("tombstones = %d, want 1", n)
		}
	})

	t.Run("delete_wins", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 300))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, del("transactions", id)), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 400))), sync.Ignored, "")
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"name":"back"}`))), sync.Ignored, "")
		if n := rowCount(t, pool, `SELECT count(*) FROM transactions WHERE id = $1`, id); n != 0 {
			t.Errorf("rows = %d, want 0", n)
		}
	})

	t.Run("delete_in_use_rejected", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, put("transactions", newID(t, pool), expense(t, a, 300))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, del("categories", a.expenseCatID)), sync.Rejected, "in_use")
		wantStatus(t, apply(t, pool, a.userID, del("accounts", a.accountID)), sync.Rejected, "in_use")
		if n := rowCount(t, pool, `SELECT count(*) FROM categories WHERE id = $1`, a.expenseCatID); n != 1 {
			t.Errorf("category rows = %d, want 1", n)
		}
		if n := rowCount(t, pool, `SELECT count(*) FROM accounts WHERE id = $1`, a.accountID); n != 1 {
			t.Errorf("account rows = %d, want 1", n)
		}
		if n := rowCount(t, pool, `SELECT count(*) FROM deleted_records WHERE id = $1 OR id = $2`, a.expenseCatID, a.accountID); n != 0 {
			t.Errorf("tombstones = %d, want 0", n)
		}
	})

	t.Run("reference_other_user_rejected", func(t *testing.T) {
		id := newID(t, pool)
		d := expense(t, a, 100)
		d["account_id"] = b.accountID
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, d)), sync.Rejected, "invalid_reference")
		if n := rowCount(t, pool, `SELECT count(*) FROM transactions WHERE id = $1`, id); n != 0 {
			t.Errorf("rows = %d, want 0", n)
		}
	})

	t.Run("category_type_mismatch_rejected", func(t *testing.T) {
		d := expense(t, a, 100)
		d["category_id"] = a.incomeCatID
		wantStatus(t, apply(t, pool, a.userID, put("transactions", newID(t, pool), d)), sync.Rejected, "invalid_category_type")

		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 100))), sync.Applied, "")
		p := data(t, `{"category_id":%q}`, a.incomeCatID)
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, p)), sync.Rejected, "invalid_category_type")
	})

	t.Run("transfer_rules", func(t *testing.T) {
		withCategory := data(t, `{"user_id":%q,"type":"transfer","amount_minor":100,"currency_code":"EUR","date":"2026-10-19",
			"name":"Move","category_id":%q,"account_id":%q,"to_account_id":%q,"source":"manual"}`,
			a.userID, a.expenseCatID, a.accountID, a.account2ID)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", newID(t, pool), withCategory)), sync.Rejected, "invalid_transfer")

		sameAccount := data(t, `{"user_id":%q,"type":"transfer","amount_minor":100,"currency_code":"EUR","date":"2026-10-19",
			"name":"Move","category_id":null,"account_id":%q,"to_account_id":%q,"source":"manual"}`,
			a.userID, a.accountID, a.accountID)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", newID(t, pool), sameAccount)), sync.Rejected, "invalid_transfer")

		id := newID(t, pool)
		ok := data(t, `{"user_id":%q,"type":"transfer","amount_minor":100,"currency_code":"EUR","date":"2026-10-19",
			"name":"Move","account_id":%q,"to_account_id":%q,"source":"manual"}`,
			a.userID, a.accountID, a.account2ID)
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, ok)), sync.Applied, "")
		p := data(t, `{"to_account_id":%q}`, a.accountID)
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, p)), sync.Rejected, "invalid_transfer")
	})

	t.Run("user_settings_rules", func(t *testing.T) {
		var settingsID string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM user_settings WHERE user_id = $1`, a.userID).Scan(&settingsID); err != nil {
			t.Fatal(err)
		}
		full := data(t, `{"user_id":%q,"currency_code":"EUR","time_period":"monthly","week_start_day":1,"month_start_day":1,
			"year_start_month":1,"budget_mode":false,"carry_over":true,"hide_future":false,"show_note":true,
			"theme":"system","summary_font":"mono","icon_style":"filled"}`, a.userID)
		wantStatus(t, apply(t, pool, a.userID, put("user_settings", settingsID, full)), sync.Rejected, "not_allowed")
		wantStatus(t, apply(t, pool, a.userID, del("user_settings", settingsID)), sync.Rejected, "not_allowed")
		wantStatus(t, apply(t, pool, a.userID, patch("user_settings", settingsID, data(t, `{"carry_over":false}`))), sync.Applied, "")
		var carryOver bool
		if err := pool.QueryRow(ctx, `SELECT carry_over FROM user_settings WHERE id = $1`, settingsID).Scan(&carryOver); err != nil {
			t.Fatal(err)
		}
		if carryOver {
			t.Error("carry_over = true, want false")
		}
	})

	t.Run("updated_at_is_server_time", func(t *testing.T) {
		id := newID(t, pool)
		d := expense(t, a, 100)
		d["created_at"] = "2000-01-01T00:00:00Z"
		d["updated_at"] = "2000-01-01T00:00:00Z"
		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, d)), sync.Applied, "")
		var first, created time.Time
		if err := pool.QueryRow(ctx, `SELECT updated_at, created_at FROM transactions WHERE id = $1`, id).Scan(&first, &created); err != nil {
			t.Fatal(err)
		}
		if first.Year() == 2000 || created.Year() == 2000 {
			t.Fatalf("updated_at = %v, created_at = %v: the client value was written", first, created)
		}

		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"name":"later"}`))), sync.Applied, "")
		var second time.Time
		if err := pool.QueryRow(ctx, `SELECT updated_at FROM transactions WHERE id = $1`, id).Scan(&second); err != nil {
			t.Fatal(err)
		}
		if !second.After(first) {
			t.Errorf("updated_at after PATCH = %v, want later than %v", second, first)
		}

		wantStatus(t, apply(t, pool, a.userID, put("transactions", id, expense(t, a, 200))), sync.Applied, "")
		var third time.Time
		if err := pool.QueryRow(ctx, `SELECT updated_at FROM transactions WHERE id = $1`, id).Scan(&third); err != nil {
			t.Fatal(err)
		}
		if !third.After(second) {
			t.Errorf("updated_at after PUT = %v, want later than %v", third, second)
		}
	})
}
