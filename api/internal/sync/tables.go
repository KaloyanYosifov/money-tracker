// Package sync validates and applies the PowerSync upload queue.
package sync

import (
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"

	"github.com/KaloyanYosifov/money-tracker/api/internal/schema"
)

// ErrUnknownTable is returned for a table that is not synced.
var ErrUnknownTable = schema.ErrUnknownTable

// tables maps each synced table to its column names. The names come from the
// json tags of the generated Go types, so SQL uses only these names.
var tables = map[string][]string{
	"accounts":        columnsOf(schema.Account{}),
	"categories":      columnsOf(schema.Category{}),
	"transactions":    columnsOf(schema.Transaction{}),
	"recurring_rules": columnsOf(schema.RecurringRule{}),
	"budgets":         columnsOf(schema.Budget{}),
	"user_settings":   columnsOf(schema.UserSettings{}),
}

// readOnly lists the fields that the client cannot write. The server sets
// them, and the op carries the ID outside of data.
var readOnly = []string{"id", "created_at", "updated_at"}

func columnsOf(v any) []string {
	t := reflect.TypeOf(v)
	cols := make([]string, 0, t.NumField())
	for f := range t.Fields() {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name != "" && name != "-" {
			cols = append(cols, name)
		}
	}
	return cols
}

// TableNames returns the synced table names in sorted order.
func TableNames() []string {
	return slices.Sorted(maps.Keys(tables))
}

// Columns returns the column names of a synced table.
func Columns(table string) ([]string, error) {
	cols, ok := tables[table]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownTable, table)
	}
	return slices.Clone(cols), nil
}

// DropReadOnly removes id, created_at and updated_at from data before a write.
func DropReadOnly(data map[string]any) {
	for _, k := range readOnly {
		delete(data, k)
	}
}
