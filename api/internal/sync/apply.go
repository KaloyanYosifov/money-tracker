package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	stdsync "sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/KaloyanYosifov/money-tracker/api/internal/schema"
)

// Status is the outcome of one upload op.
type Status int

const (
	// Applied means the op changed the database.
	Applied Status = iota
	// Ignored means the op targets a deleted record. The client drops it.
	Ignored
	// Rejected means the op can never succeed. Code and Message say why.
	Rejected
)

// Result is the outcome of ApplyOp. Code and Message are set only for Rejected.
type Result struct {
	Status  Status
	Code    string
	Message string
}

func reject(code, msg string) Result {
	return Result{Status: Rejected, Code: code, Message: msg}
}

var validator = stdsync.OnceValues(schema.NewValidator)

// ApplyOp validates one upload op and applies it for userID inside tx.
// The op runs in a savepoint: if the result is Rejected or the error is not
// nil, tx is still usable and the op left no changes. An error means a
// failure that is not the fault of the op (for example a lost connection).
func ApplyOp(ctx context.Context, tx pgx.Tx, userID string, op schema.UploadOp) (Result, error) {
	table := string(op.Table)
	cols, err := Columns(table)
	if err != nil {
		return reject("invalid_record", err.Error()), nil
	}

	sp, err := tx.Begin(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("savepoint: %w", err)
	}
	res, err := applyOp(ctx, sp, userID, table, cols, op)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			if r, ok := mapPgError(pgErr, op.Op); ok {
				res, err = r, nil
			}
		}
	}
	if err != nil || res.Status == Rejected {
		if rbErr := sp.Rollback(ctx); rbErr != nil && err == nil {
			err = fmt.Errorf("rollback savepoint: %w", rbErr)
		}
		if err != nil {
			return Result{}, err
		}
		return res, nil
	}
	if err := sp.Commit(ctx); err != nil {
		return Result{}, fmt.Errorf("release savepoint: %w", err)
	}
	return res, nil
}

// kindChecks are the CHECK constraints in 00001_core.sql for the transfer and
// expense or income column rules.
var kindChecks = map[string]bool{
	"transactions_kind_check":    true,
	"recurring_rules_kind_check": true,
}

// mapPgError turns a constraint error into a rejection.
func mapPgError(e *pgconn.PgError, op schema.UploadOpOp) (Result, bool) {
	switch {
	case e.Code == "23503" && op == schema.UploadOpOpDELETE:
		return reject("in_use", "other records still use this record"), true
	case e.Code == "23503":
		return reject("invalid_reference", "a referenced record does not exist"), true
	case e.Code == "23514" && kindChecks[e.ConstraintName]:
		return reject("invalid_transfer", "the record breaks the transfer rules"), true
	case strings.HasPrefix(e.Code, "22") || strings.HasPrefix(e.Code, "23"):
		return reject("invalid_record", e.Message), true
	}
	return Result{}, false
}

func applyOp(ctx context.Context, tx pgx.Tx, userID, table string, cols []string, op schema.UploadOp) (Result, error) {
	if table == "user_settings" && op.Op != schema.UploadOpOpPATCH {
		return reject("not_allowed", "user_settings accepts only PATCH"), nil
	}
	if op.Op == schema.UploadOpOpDELETE {
		return applyDelete(ctx, tx, userID, table, op.ID)
	}

	var deleted bool
	err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM deleted_records WHERE table_name = $1 AND id = $2)`,
		table, op.ID).Scan(&deleted)
	if err != nil {
		return Result{}, fmt.Errorf("check tombstone: %w", err)
	}
	if deleted {
		return Result{Status: Ignored}, nil
	}

	v, err := validator()
	if err != nil {
		return Result{}, fmt.Errorf("schema validator: %w", err)
	}
	data := maps.Clone(map[string]any(op.Data))
	if data == nil {
		data = map[string]any{}
	}
	switch op.Op {
	case schema.UploadOpOpPUT:
		data["id"] = op.ID
		err = v.ValidatePut(table, data)
	case schema.UploadOpOpPATCH:
		err = v.ValidatePatch(table, data)
	default:
		return reject("invalid_record", fmt.Sprintf("unknown op %q", op.Op)), nil
	}
	if err != nil {
		return reject("invalid_record", err.Error()), nil
	}
	DropReadOnly(data)
	if owner, ok := data["user_id"]; ok {
		if s, _ := owner.(string); !strings.EqualFold(s, userID) {
			return reject("forbidden", "user_id does not match the logged in user"), nil
		}
		delete(data, "user_id")
	}

	if table == "transactions" || table == "recurring_rules" {
		r, err := checkKind(ctx, tx, userID, table, op, data)
		if err != nil {
			return Result{}, err
		}
		if r != nil {
			return *r, nil
		}
	}

	// Only whitelisted column names reach the SQL text. The schema already
	// rejects other properties, so this is a second guard.
	var set []string
	for _, c := range slices.Sorted(maps.Keys(data)) {
		if !slices.Contains(cols, c) {
			return reject("invalid_record", fmt.Sprintf("unknown field %q", c)), nil
		}
		set = append(set, c)
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return reject("invalid_record", err.Error()), nil
	}

	if op.Op == schema.UploadOpOpPUT {
		return put(ctx, tx, userID, table, op.ID, set, payload)
	}
	return patch(ctx, tx, userID, table, op.ID, set, payload)
}

func put(ctx context.Context, tx pgx.Tx, userID, table, id string, set []string, payload []byte) (Result, error) {
	t := pgx.Identifier{table}.Sanitize()
	insertCols := []string{"id", "user_id"}
	selectCols := []string{"$2::uuid", "$3::uuid"}
	updates := make([]string, 0, len(set)+1)
	for _, c := range set {
		q := pgx.Identifier{c}.Sanitize()
		insertCols = append(insertCols, q)
		selectCols = append(selectCols, "r."+q)
		updates = append(updates, q+" = EXCLUDED."+q)
	}
	updates = append(updates, "updated_at = now()")
	sql := fmt.Sprintf(
		`INSERT INTO %[1]s (%[2]s)
		 SELECT %[3]s FROM jsonb_populate_record(NULL::%[1]s, $1::jsonb) AS r
		 ON CONFLICT (id) DO UPDATE SET %[4]s WHERE %[1]s.user_id = $3::uuid
		 RETURNING id`,
		t, strings.Join(insertCols, ", "), strings.Join(selectCols, ", "), strings.Join(updates, ", "))

	var got string
	err := tx.QueryRow(ctx, sql, string(payload), id, userID).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return reject("forbidden", "the record belongs to another user"), nil
	}
	if err != nil {
		return Result{}, fmt.Errorf("put %s: %w", table, err)
	}
	return Result{Status: Applied}, nil
}

func patch(ctx context.Context, tx pgx.Tx, userID, table, id string, set []string, payload []byte) (Result, error) {
	t := pgx.Identifier{table}.Sanitize()
	updates := make([]string, 0, len(set)+1)
	for _, c := range set {
		q := pgx.Identifier{c}.Sanitize()
		updates = append(updates, q+" = r."+q)
	}
	updates = append(updates, "updated_at = now()")
	sql := fmt.Sprintf(
		`UPDATE %[1]s SET %[2]s
		 FROM jsonb_populate_record(NULL::%[1]s, $1::jsonb) AS r
		 WHERE %[1]s.id = $2 AND %[1]s.user_id = $3
		 RETURNING %[1]s.id`,
		t, strings.Join(updates, ", "))

	var got string
	err := tx.QueryRow(ctx, sql, string(payload), id, userID).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectPatchTarget(ctx, tx, table, id)
	}
	if err != nil {
		return Result{}, fmt.Errorf("patch %s: %w", table, err)
	}
	return Result{Status: Applied}, nil
}

// rejectPatchTarget rejects a PATCH whose record the user does not have. Like PUT and
// DELETE, a record of another user is forbidden. A record that does not exist is not_found.
func rejectPatchTarget(ctx context.Context, tx pgx.Tx, table, id string) (Result, error) {
	var other bool
	err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1)`, pgx.Identifier{table}.Sanitize()), id).
		Scan(&other)
	if err != nil {
		return Result{}, fmt.Errorf("check owner: %w", err)
	}
	if other {
		return reject("forbidden", "the record belongs to another user"), nil
	}
	return reject("not_found", "the record does not exist"), nil
}

func applyDelete(ctx context.Context, tx pgx.Tx, userID, table, id string) (Result, error) {
	t := pgx.Identifier{table}.Sanitize()
	tag, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE id = $1 AND user_id = $2`, t), id, userID)
	if err != nil {
		return Result{}, fmt.Errorf("delete %s: %w", table, err)
	}
	if tag.RowsAffected() == 0 {
		var other bool
		err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1)`, t), id).Scan(&other)
		if err != nil {
			return Result{}, fmt.Errorf("check owner: %w", err)
		}
		if other {
			return reject("forbidden", "the record belongs to another user"), nil
		}
		return Result{Status: Ignored}, nil
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO deleted_records (table_name, id, user_id) VALUES ($1, $2, $3)
		 ON CONFLICT (table_name, id) DO NOTHING`, table, id, userID)
	if err != nil {
		return Result{}, fmt.Errorf("insert tombstone: %w", err)
	}
	return Result{Status: Applied}, nil
}

// kind holds the fields of a transaction or recurring rule that decide its
// type rules.
type kind struct {
	typ                                string
	categoryID, accountID, toAccountID *string
}

// checkKind checks the transfer rules and the category type of a transaction
// or recurring rule. For PATCH it combines the stored row with data. It
// returns nil if the record is valid.
func checkKind(ctx context.Context, tx pgx.Tx, userID, table string, op schema.UploadOp, data map[string]any) (*Result, error) {
	var k kind
	if op.Op == schema.UploadOpOpPATCH {
		err := tx.QueryRow(ctx, fmt.Sprintf(
			`SELECT type, category_id::text, account_id::text, to_account_id::text
			 FROM %s WHERE id = $1 AND user_id = $2 FOR UPDATE`, pgx.Identifier{table}.Sanitize()),
			op.ID, userID).Scan(&k.typ, &k.categoryID, &k.accountID, &k.toAccountID)
		if errors.Is(err, pgx.ErrNoRows) {
			r, err := rejectPatchTarget(ctx, tx, table, op.ID)
			if err != nil {
				return nil, err
			}
			return &r, nil
		}
		if err != nil {
			return nil, fmt.Errorf("load %s: %w", table, err)
		}
	}
	if v, ok := data["type"]; ok {
		k.typ, _ = v.(string)
	}
	for field, dst := range map[string]**string{
		"category_id": &k.categoryID, "account_id": &k.accountID, "to_account_id": &k.toAccountID,
	} {
		if v, ok := data[field]; ok {
			s, isString := v.(string)
			if isString {
				*dst = &s
			} else {
				*dst = nil
			}
		}
	}

	if k.typ == "transfer" {
		if k.categoryID != nil || k.toAccountID == nil || (k.accountID != nil && *k.toAccountID == *k.accountID) {
			r := reject("invalid_transfer", "a transfer needs two different accounts and no category")
			return &r, nil
		}
		return nil, nil
	}
	if k.categoryID == nil || k.toAccountID != nil {
		r := reject("invalid_record", "expense and income need a category and no to_account_id")
		return &r, nil
	}
	var catType string
	err := tx.QueryRow(ctx, `SELECT type FROM categories WHERE id = $1 AND user_id = $2`,
		*k.categoryID, userID).Scan(&catType)
	if errors.Is(err, pgx.ErrNoRows) {
		r := reject("invalid_reference", "the category does not exist")
		return &r, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load category: %w", err)
	}
	if catType != k.typ {
		r := reject("invalid_category_type", fmt.Sprintf("a %s needs a %s category", k.typ, k.typ))
		return &r, nil
	}
	return nil, nil
}
