package sync_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/sync"
)

func TestTableWhitelist(t *testing.T) {
	want := map[string][]string{
		"accounts":          {"id", "user_id", "name", "color", "sort_order", "opening_balance_minor", "exclude_from_carry_over", "archived_at"},
		"categories":        {"id", "user_id", "type", "name", "icon", "color", "sort_order", "archived_at"},
		"transactions":      {"id", "user_id", "type", "amount_minor", "currency_code", "date", "name", "category_id", "account_id", "to_account_id", "note", "recurring_rule_id", "source", "import_batch_id", "external_id", "created_at", "updated_at"},
		"recurring_rules":   {"id", "user_id", "type", "amount_minor", "name", "category_id", "account_id", "to_account_id", "note", "frequency", "start_date", "end_date", "generated_through"},
		"budgets":           {"id", "user_id", "category_id", "period", "amount_minor"},
		"user_settings":     {"id", "user_id", "currency_code", "time_period", "week_start_day", "month_start_day", "year_start_month", "budget_mode", "carry_over", "hide_future", "show_note", "theme", "summary_font", "icon_style", "insights_enabled"},
		"insights":          {"id", "user_id", "kind", "title", "body", "fingerprint", "status", "action", "created_at", "updated_at"},
		"insight_questions": {"id", "user_id", "category_id", "question", "answer", "action", "status", "error", "created_at", "updated_at", "answered_at"},
	}
	if got := sync.TableNames(); len(got) != len(want) {
		t.Errorf("TableNames() = %v, want %d tables", got, len(want))
	}
	for name, cols := range want {
		got, err := sync.Columns(name)
		if err != nil {
			t.Errorf("Columns(%q): %v", name, err)
			continue
		}
		g, w := slices.Sorted(slices.Values(got)), slices.Sorted(slices.Values(cols))
		if !slices.Equal(g, w) {
			t.Errorf("Columns(%q) = %v, want %v", name, g, w)
		}
	}
	for _, name := range []string{"users", "refresh_tokens", "deleted_records", "accounts; DROP TABLE users", ""} {
		if _, err := sync.Columns(name); !errors.Is(err, sync.ErrUnknownTable) {
			t.Errorf("Columns(%q) error = %v, want ErrUnknownTable", name, err)
		}
	}
}

func TestReadOnlyFields(t *testing.T) {
	data := map[string]any{
		"id":         "0b6f3c1e-8d2a-4c47-9a51-2f7e9d3b1a10",
		"created_at": "2026-10-19T10:00:00Z",
		"updated_at": "2026-10-19T10:00:00Z",
		"name":       "Lunch",
		"note":       nil,
	}
	sync.DropReadOnly(data)
	for _, k := range []string{"id", "created_at", "updated_at"} {
		if _, ok := data[k]; ok {
			t.Errorf("%s was not dropped", k)
		}
	}
	if data["name"] != "Lunch" {
		t.Errorf("name = %v, want Lunch", data["name"])
	}
	if v, ok := data["note"]; !ok || v != nil {
		t.Errorf("note = %v (present %v), want an explicit null that stays", v, ok)
	}
}
