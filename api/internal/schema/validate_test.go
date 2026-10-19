package schema_test

import (
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/KaloyanYosifov/money-tracker/api/internal/schema"
)

const (
	recID   = "0b6f3c1e-8d2a-4c47-9a51-2f7e9d3b1a10"
	userID  = "5a1d7e2c-3b4f-4e6a-8c9d-1f2e3a4b5c6d"
	otherID = "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
)

var fullRecords = map[string]string{
	"accounts":   `{"id":"` + recID + `","user_id":"` + userID + `","name":"Wallet","color":"#12ab34","sort_order":0,"archived_at":null}`,
	"categories": `{"id":"` + recID + `","user_id":"` + userID + `","type":"expense","name":"Food","icon":"food","color":"#12ab34","sort_order":1}`,
	"transactions": `{"id":"` + recID + `","user_id":"` + userID + `","type":"expense","amount_minor":1250,"currency_code":"EUR",` +
		`"date":"2026-10-19","name":"Lunch","category_id":"` + otherID + `","account_id":"` + otherID + `","to_account_id":null,` +
		`"note":null,"recurring_rule_id":null,"source":"manual","import_batch_id":null,"external_id":null}`,
	"recurring_rules": `{"id":"` + recID + `","user_id":"` + userID + `","type":"income","amount_minor":300000,"name":"Salary",` +
		`"category_id":"` + otherID + `","account_id":"` + otherID + `","frequency":"monthly","start_date":"2026-10-01","end_date":null}`,
	"budgets": `{"id":"` + recID + `","user_id":"` + userID + `","category_id":null,"period":"monthly","amount_minor":50000}`,
	"user_settings": `{"id":"` + recID + `","user_id":"` + userID + `","currency_code":"EUR","time_period":"monthly","week_start_day":1,` +
		`"month_start_day":1,"year_start_month":1,"budget_mode":false,"carry_over":true,"hide_future":false,"show_note":true,` +
		`"theme":"system","summary_font":"mono","icon_style":"filled"}`,
}

func decode(t *testing.T, s string) any {
	t.Helper()
	v, err := jsonschema.UnmarshalJSON(strings.NewReader(s))
	if err != nil {
		t.Fatalf("decode %s: %v", s, err)
	}
	return v
}

func newValidator(t *testing.T) *schema.Validator {
	t.Helper()
	v, err := schema.NewValidator()
	if err != nil {
		t.Fatalf("NewValidator: %v", err)
	}
	return v
}

func TestValidateFullRecord(t *testing.T) {
	v := newValidator(t)
	for table, rec := range fullRecords {
		if err := v.ValidatePut(table, decode(t, rec)); err != nil {
			t.Errorf("%s: valid record rejected: %v", table, err)
		}
	}

	bad := []struct {
		name, table, data, field string
	}{
		{"extra property", "accounts",
			`{"id":"` + recID + `","user_id":"` + userID + `","name":"W","color":"#12ab34","sort_order":0,"balance":5}`, "balance"},
		{"wrong enum", "categories",
			`{"id":"` + recID + `","user_id":"` + userID + `","type":"gift","name":"F","icon":"food","color":"#12ab34","sort_order":1}`, "type"},
		{"float amount", "budgets",
			`{"id":"` + recID + `","user_id":"` + userID + `","period":"monthly","amount_minor":12.5}`, "amount_minor"},
		{"missing required", "budgets",
			`{"id":"` + recID + `","user_id":"` + userID + `","period":"monthly"}`, "amount_minor"},
		{"bad uuid format", "accounts",
			`{"id":"not-a-uuid","user_id":"` + userID + `","name":"W","color":"#12ab34","sort_order":0}`, "id"},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			err := v.ValidatePut(tc.table, decode(t, tc.data))
			if err == nil {
				t.Fatal("invalid record accepted")
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Errorf("message %q does not name field %q", err, tc.field)
			}
		})
	}
}

func TestValidatePatch(t *testing.T) {
	v := newValidator(t)
	if err := v.ValidatePatch("transactions", decode(t, `{"id":"`+recID+`","note":"lunch with Ana"}`)); err != nil {
		t.Errorf("partial patch rejected: %v", err)
	}
	if err := v.ValidatePatch("user_settings", decode(t, `{"theme":"dark"}`)); err != nil {
		t.Errorf("partial patch rejected: %v", err)
	}

	err := v.ValidatePatch("transactions", decode(t, `{"id":"`+recID+`","tip":5}`))
	if err == nil || !strings.Contains(err.Error(), "tip") {
		t.Errorf("unknown property: got %v, want an error that names tip", err)
	}
	err = v.ValidatePatch("transactions", decode(t, `{"amount_minor":1.5}`))
	if err == nil || !strings.Contains(err.Error(), "amount_minor") {
		t.Errorf("float amount: got %v, want an error that names amount_minor", err)
	}
}

func TestValidateUnknownTable(t *testing.T) {
	v := newValidator(t)
	if err := v.ValidatePut("users", decode(t, `{}`)); err == nil {
		t.Error("PUT on unknown table accepted")
	}
	if err := v.ValidatePatch("users", decode(t, `{}`)); err == nil {
		t.Error("PATCH on unknown table accepted")
	}
}

func TestValidateUpload(t *testing.T) {
	v := newValidator(t)
	ok := `{"schema_version":1,"ops":[{"op":"DELETE","table":"accounts","id":"` + recID + `"}]}`
	if err := v.ValidateUpload(decode(t, ok)); err != nil {
		t.Errorf("valid upload rejected: %v", err)
	}
	missingData := `{"schema_version":1,"ops":[{"op":"PUT","table":"accounts","id":"` + recID + `"}]}`
	if err := v.ValidateUpload(decode(t, missingData)); err == nil {
		t.Error("PUT without data accepted")
	}
}
