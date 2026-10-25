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

	t.Run("patch_other_users_row_rejected", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, b.userID, put("transactions", id, expense(t, b, 700))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, patch("transactions", id, data(t, `{"name":"x"}`))), sync.Rejected, "forbidden")
		var name string
		if err := pool.QueryRow(ctx, `SELECT name FROM transactions WHERE id = $1`, id).Scan(&name); err != nil {
			t.Fatal(err)
		}
		if name == "x" {
			t.Error("the patch of another user changed the row")
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

func TestApplyAccountOpeningBalance(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")

	balance := func(id string) int64 {
		t.Helper()
		var v int64
		if err := pool.QueryRow(ctx, `SELECT opening_balance_minor FROM accounts WHERE id = $1`, id).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}

	first := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("accounts", first, data(t,
		`{"user_id":%q,"name":"Savings","color":"#112233","sort_order":5,"opening_balance_minor":-5000}`, a.userID))), sync.Applied, "")
	if got := balance(first); got != -5000 {
		t.Errorf("opening_balance_minor = %d, want -5000", got)
	}

	second := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("accounts", second, data(t,
		`{"user_id":%q,"name":"Card","color":"#112233","sort_order":6}`, a.userID))), sync.Applied, "")
	if got := balance(second); got != 0 {
		t.Errorf("opening_balance_minor with no value = %d, want 0", got)
	}

	wantStatus(t, apply(t, pool, a.userID, patch("accounts", first, data(t, `{"name":"Savings 2"}`))), sync.Applied, "")
	if got := balance(first); got != -5000 {
		t.Errorf("opening_balance_minor after PATCH = %d, want -5000", got)
	}

	third := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("accounts", third, data(t,
		`{"user_id":%q,"name":"Too big","color":"#112233","sort_order":7,"opening_balance_minor":1000000000001}`, a.userID))), sync.Rejected, "invalid_record")
}

func TestApplyAccountExcludeFromCarryOver(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")

	excluded := func(id string) bool {
		t.Helper()
		var v bool
		if err := pool.QueryRow(ctx, `SELECT exclude_from_carry_over FROM accounts WHERE id = $1`, id).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}

	first := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("accounts", first, data(t,
		`{"user_id":%q,"name":"No account","color":"#112233","sort_order":5,"exclude_from_carry_over":true}`, a.userID))), sync.Applied, "")
	if !excluded(first) {
		t.Error("exclude_from_carry_over = false, want true")
	}

	second := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("accounts", second, data(t,
		`{"user_id":%q,"name":"Card","color":"#112233","sort_order":6}`, a.userID))), sync.Applied, "")
	if excluded(second) {
		t.Error("exclude_from_carry_over with no value = true, want false")
	}

	wantStatus(t, apply(t, pool, a.userID, patch("accounts", first, data(t, `{"name":"No account 2"}`))), sync.Applied, "")
	if !excluded(first) {
		t.Error("exclude_from_carry_over after PATCH = false, want true")
	}
}

func TestApplyRecurringRule(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")

	rule := func(frequency, start, end, through string) schema.UploadOpData {
		return data(t, `{"user_id":%q,"type":"expense","amount_minor":999,"name":"Insurance","category_id":%q,
			"account_id":%q,"frequency":%q,"start_date":%q,"end_date":%s,"generated_through":%s}`,
			a.userID, a.expenseCatID, a.accountID, frequency, start, end, through)
	}
	stored := func(id string) (frequency, end, through string) {
		t.Helper()
		err := pool.QueryRow(ctx,
			`SELECT frequency, COALESCE(end_date::text, ''), COALESCE(generated_through::text, '') FROM recurring_rules WHERE id = $1`, id).
			Scan(&frequency, &end, &through)
		if err != nil {
			t.Fatal(err)
		}
		return frequency, end, through
	}

	id := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("recurring_rules", id, rule("quarterly", "2026-01-15", "null", `"2026-10-15"`))), sync.Applied, "")
	if f, _, through := stored(id); f != "quarterly" || through != "2026-10-15" {
		t.Errorf("stored frequency %q, generated_through %q; want quarterly, 2026-10-15", f, through)
	}

	wantStatus(t, apply(t, pool, a.userID, patch("recurring_rules", id, data(t, `{"generated_through":"2027-01-15"}`))), sync.Applied, "")
	if _, _, through := stored(id); through != "2027-01-15" {
		t.Errorf("generated_through after PATCH = %q, want 2027-01-15", through)
	}
	wantStatus(t, apply(t, pool, a.userID, patch("recurring_rules", id, data(t, `{"generated_through":null}`))), sync.Applied, "")
	if _, _, through := stored(id); through != "" {
		t.Errorf("generated_through after PATCH to null = %q, want NULL", through)
	}

	// A rule may end on the day it starts, but not before.
	same := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("recurring_rules", same, rule("monthly", "2026-01-15", `"2026-01-15"`, "null"))), sync.Applied, "")

	before := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("recurring_rules", before, rule("monthly", "2026-01-15", `"2026-01-14"`, "null"))), sync.Rejected, "invalid_record")
	wantStatus(t, apply(t, pool, a.userID, patch("recurring_rules", id, data(t, `{"end_date":"2026-01-14"}`))), sync.Rejected, "invalid_record")
	wantStatus(t, apply(t, pool, a.userID, patch("recurring_rules", id, data(t, `{"start_date":"2026-02-01","end_date":"2026-01-31"}`))), sync.Rejected, "invalid_record")
	if _, end, _ := stored(id); end != "" {
		t.Errorf("end_date after rejected PATCH = %q, want NULL", end)
	}

	wantStatus(t, apply(t, pool, a.userID, put("recurring_rules", newID(t, pool), rule("hourly", "2026-01-15", "null", "null"))), sync.Rejected, "invalid_record")
	wantStatus(t, apply(t, pool, a.userID, put("recurring_rules", newID(t, pool), rule("monthly", "2026-01-15", "null", `"15.01.2026"`))), sync.Rejected, "invalid_record")
}

func TestApplyRecurringOccurrencePut(t *testing.T) {
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")

	occurrence := func(amount int, external string) schema.UploadOpData {
		return data(t, `{"user_id":%q,"type":"expense","amount_minor":%d,"currency_code":"EUR","date":"2026-10-01",
			"name":"Rent","category_id":%q,"account_id":%q,"note":null,"source":"recurring","external_id":%s}`,
			a.userID, amount, a.expenseCatID, a.accountID, external)
	}
	amount := func(id string) int {
		t.Helper()
		return rowCount(t, pool, `SELECT amount_minor FROM transactions WHERE id = $1`, id)
	}

	// The app generator: a second PUT of the same occurrence keeps the stored row.
	generated := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("transactions", generated, occurrence(1000, "null"))), sync.Applied, "")
	wantStatus(t, apply(t, pool, a.userID, put("transactions", generated, occurrence(2000, "null"))), sync.Applied, "")
	if got := amount(generated); got != 1000 {
		t.Errorf("generated occurrence amount after second PUT = %d, want 1000", got)
	}

	// The importer sets external_id: a second import updates the row.
	imported := newID(t, pool)
	wantStatus(t, apply(t, pool, a.userID, put("transactions", imported, occurrence(1000, `"st:301"`))), sync.Applied, "")
	wantStatus(t, apply(t, pool, a.userID, put("transactions", imported, occurrence(2000, `"st:301"`))), sync.Applied, "")
	if got := amount(imported); got != 2000 {
		t.Errorf("imported occurrence amount after second PUT = %d, want 2000", got)
	}
}

func TestApplyInsightsTablesAreServerOwned(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	a := seedUser(t, pool, "a@example.com")
	b := seedUser(t, pool, "b@example.com")

	insight := newID(t, pool)
	_, err := pool.Exec(ctx,
		`INSERT INTO insights (id, user_id, kind, title, body, fingerprint, status)
		 VALUES ($1, $2, 'tip', 'Cook more', 'You eat out a lot.', 'tip:eating-out', 'open')`, insight, a.userID)
	if err != nil {
		t.Fatal(err)
	}
	insightStatus := func() string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT status FROM insights WHERE id = $1`, insight).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}

	t.Run("insights_put_not_allowed", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, put("insights", newID(t, pool), data(t,
			`{"user_id":%q,"kind":"tip","title":"T","body":"B","fingerprint":"f","status":"open"}`, a.userID))), sync.Rejected, "not_allowed")
	})
	t.Run("insights_delete_not_allowed", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, del("insights", insight)), sync.Rejected, "not_allowed")
	})
	t.Run("insights_patch_title_not_allowed", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, patch("insights", insight, data(t, `{"title":"Changed"}`))), sync.Rejected, "not_allowed")
	})
	t.Run("insights_patch_status_and_title_not_allowed", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, patch("insights", insight, data(t,
			`{"status":"dismissed","title":"Changed"}`))), sync.Rejected, "not_allowed")
	})
	t.Run("insights_patch_status_open_invalid", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, patch("insights", insight, data(t, `{"status":"open"}`))), sync.Rejected, "invalid_record")
	})
	t.Run("insights_patch_other_user_forbidden", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, patch("insights", insight, data(t,
			`{"user_id":%q,"status":"dismissed"}`, b.userID))), sync.Rejected, "forbidden")
		wantStatus(t, apply(t, pool, b.userID, patch("insights", insight, data(t, `{"status":"dismissed"}`))), sync.Rejected, "forbidden")
		if got := insightStatus(); got != "open" {
			t.Fatalf("status = %q, want open", got)
		}
	})
	t.Run("insights_patch_status_applies", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, patch("insights", insight, data(t,
			`{"user_id":%q,"status":"dismissed"}`, a.userID))), sync.Applied, "")
		if got := insightStatus(); got != "dismissed" {
			t.Fatalf("status = %q, want dismissed", got)
		}
	})

	question := func(f fixture, status, extra string) schema.UploadOpData {
		return data(t, `{"user_id":%q,"category_id":%q,"question":"Why so much?","status":%q%s}`,
			f.userID, f.expenseCatID, status, extra)
	}
	t.Run("questions_put_opted_out_not_allowed", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", newID(t, pool), question(a, "pending", ""))), sync.Rejected, "not_allowed")
	})
	if _, err := pool.Exec(ctx, `UPDATE user_settings SET insights_enabled = true WHERE user_id IN ($1, $2)`, a.userID, b.userID); err != nil {
		t.Fatal(err)
	}
	t.Run("questions_put_pending_applies", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", id, question(a, "pending", ""))), sync.Applied, "")
		if n := rowCount(t, pool, `SELECT count(*) FROM insight_questions WHERE id = $1 AND status = 'pending'`, id); n != 1 {
			t.Fatalf("pending questions = %d, want 1", n)
		}
	})
	t.Run("questions_put_answered_not_allowed", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", newID(t, pool), question(a, "answered", ""))), sync.Rejected, "not_allowed")
	})
	t.Run("questions_put_answer_not_allowed", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", newID(t, pool),
			question(a, "pending", `,"answer":"Because."`))), sync.Rejected, "not_allowed")
	})
	t.Run("questions_put_unknown_category", func(t *testing.T) {
		d := data(t, `{"user_id":%q,"category_id":%q,"question":"Why so much?","status":"pending"}`, a.userID, b.expenseCatID)
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", newID(t, pool), d)), sync.Rejected, "invalid_reference")
	})
	t.Run("questions_put_other_user_forbidden", func(t *testing.T) {
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", newID(t, pool), question(b, "pending", ""))), sync.Rejected, "forbidden")
	})
	t.Run("questions_patch_and_delete_not_allowed", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", id, question(a, "pending", ""))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, patch("insight_questions", id, data(t, `{"status":"pending"}`))), sync.Rejected, "not_allowed")
		wantStatus(t, apply(t, pool, a.userID, del("insight_questions", id)), sync.Rejected, "not_allowed")
	})
	t.Run("questions_put_again_keeps_answer", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", id, question(a, "pending", ""))), sync.Applied, "")
		if _, err := pool.Exec(ctx, `UPDATE insight_questions SET status = 'answered', answer = 'Because.' WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", id, question(a, "pending", ""))), sync.Applied, "")
		if n := rowCount(t, pool, `SELECT count(*) FROM insight_questions WHERE id = $1 AND status = 'answered'`, id); n != 1 {
			t.Fatalf("answered questions after a second PUT = %d, want 1", n)
		}
		wantStatus(t, apply(t, pool, b.userID, put("insight_questions", id, question(b, "pending", ""))), sync.Rejected, "forbidden")
	})
	t.Run("questions_put_again_after_opt_out_applies", func(t *testing.T) {
		id := newID(t, pool)
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", id, question(a, "pending", ""))), sync.Applied, "")
		if _, err := pool.Exec(ctx, `UPDATE user_settings SET insights_enabled = false WHERE user_id = $1`, a.userID); err != nil {
			t.Fatal(err)
		}
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", id, question(a, "pending", ""))), sync.Applied, "")
		wantStatus(t, apply(t, pool, a.userID, put("insight_questions", newID(t, pool), question(a, "pending", ""))), sync.Rejected, "not_allowed")
	})
}
