// Package insights holds the AI insight cards and question answers: their
// types, the checks before a write, the daily run and the question worker.
package insights

import "encoding/json"

// MaxAmountMinor is the largest amount in minor units. It is a copy of
// MAX_AMOUNT_MINOR in app/src/domain/money.ts.
const MaxAmountMinor int64 = 1_000_000_000_000

// Card kinds.
const (
	KindTip           = "tip"
	KindBudget        = "budget"
	KindRecurringRule = "recurring_rule"
)

// Card is one suggestion from the daily run. Action is the raw JSON of a
// BudgetAction (kind budget), a RecurringAction (kind recurring_rule) or
// nothing (kind tip). CheckCard decodes it strictly into the typed action.
type Card struct {
	Kind        string          `json:"kind"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	Fingerprint string          `json:"fingerprint"`
	Action      json.RawMessage `json:"action,omitempty"`
}

// BudgetAction proposes a monthly budget for one expense category.
type BudgetAction struct {
	CategoryID  string `json:"category_id"`
	AmountMinor int64  `json:"amount_minor"`
}

// RecurringAction proposes a recurring rule. Type is expense or income.
type RecurringAction struct {
	Type        string  `json:"type"`
	CategoryID  string  `json:"category_id"`
	AccountID   *string `json:"account_id,omitempty"`
	AmountMinor int64   `json:"amount_minor"`
	Frequency   string  `json:"frequency"`
	StartDate   string  `json:"start_date"`
	EndDate     *string `json:"end_date,omitempty"`
	Name        string  `json:"name"`
	Note        *string `json:"note,omitempty"`
}

// UserData is the part of one user's data that the checks need.
type UserData struct {
	Categories []Category
	Budgets    []CategoryBudget
}

// Category is one of the user's categories. Type is expense or income.
type Category struct {
	ID       string
	Type     string
	Archived bool
}

// CategoryBudget is the budget of one category.
type CategoryBudget struct {
	CategoryID  string
	AmountMinor int64
}
