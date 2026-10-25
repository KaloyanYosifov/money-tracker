package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"
	"unicode/utf8"
)

// frequencies are the values of recurring_rule.schema.json frequency.
var frequencies = []string{"daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"}

// CheckCard returns an error that names the reason when the card must not be
// written: an unknown kind, a text out of range, or an action that does not
// match the kind or the user's data.
func CheckCard(card Card, data UserData) error {
	if err := checkText("title", card.Title, 80); err != nil {
		return err
	}
	if err := checkText("body", card.Body, 500); err != nil {
		return err
	}
	if err := checkText("fingerprint", card.Fingerprint, 200); err != nil {
		return err
	}
	hasAction := !isNull(card.Action)
	switch card.Kind {
	case KindTip:
		if hasAction {
			return errors.New("a tip card has an action")
		}
		return nil
	case KindBudget:
		if !hasAction {
			return errors.New("a budget card has no action")
		}
		return checkBudget(card.Action, data)
	case KindRecurringRule:
		if !hasAction {
			return errors.New("a recurring_rule card has no action")
		}
		return checkRecurring(card.Action, data)
	default:
		return fmt.Errorf("unknown card kind %q", card.Kind)
	}
}

// CheckAnswerAction checks the optional action of a question answer with the
// same rules as a card's action. An action with a frequency is a recurring
// rule; any other action is a budget.
func CheckAnswerAction(action json.RawMessage, data UserData) error {
	if isNull(action) {
		return nil
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(action, &keys); err != nil {
		return fmt.Errorf("action is not an object: %w", err)
	}
	if _, ok := keys["frequency"]; ok {
		return checkRecurring(action, data)
	}
	return checkBudget(action, data)
}

func checkBudget(raw json.RawMessage, data UserData) error {
	var a BudgetAction
	if err := decodeStrict(raw, &a); err != nil {
		return fmt.Errorf("budget action: %w", err)
	}
	if err := checkAmount(a.AmountMinor); err != nil {
		return err
	}
	return checkCategory(a.CategoryID, "expense", data)
}

func checkRecurring(raw json.RawMessage, data UserData) error {
	var a RecurringAction
	if err := decodeStrict(raw, &a); err != nil {
		return fmt.Errorf("recurring rule action: %w", err)
	}
	if a.Type != "expense" && a.Type != "income" {
		return fmt.Errorf("recurring rule type %q is not expense or income", a.Type)
	}
	if err := checkAmount(a.AmountMinor); err != nil {
		return err
	}
	if err := checkCategory(a.CategoryID, a.Type, data); err != nil {
		return err
	}
	if !slices.Contains(frequencies, a.Frequency) {
		return fmt.Errorf("unknown frequency %q", a.Frequency)
	}
	if !isDate(a.StartDate) {
		return fmt.Errorf("start_date %q is not a YYYY-MM-DD date", a.StartDate)
	}
	if a.EndDate != nil {
		if !isDate(*a.EndDate) {
			return fmt.Errorf("end_date %q is not a YYYY-MM-DD date", *a.EndDate)
		}
		if *a.EndDate < a.StartDate {
			return errors.New("end_date is before start_date")
		}
	}
	if utf8.RuneCountInString(a.Name) > 120 {
		return errors.New("name is longer than 120 characters")
	}
	if a.Note != nil && utf8.RuneCountInString(*a.Note) > 2000 {
		return errors.New("note is longer than 2000 characters")
	}
	return nil
}

// checkCategory checks that the category exists, is not archived and has the
// wanted type.
func checkCategory(id, wantType string, data UserData) error {
	i := slices.IndexFunc(data.Categories, func(c Category) bool { return c.ID == id })
	if i < 0 {
		return fmt.Errorf("unknown category %q", id)
	}
	c := data.Categories[i]
	if c.Archived {
		return fmt.Errorf("category %q is archived", id)
	}
	if c.Type != wantType {
		return fmt.Errorf("category %q is %s, not %s", id, c.Type, wantType)
	}
	return nil
}

func checkAmount(amount int64) error {
	if amount < 1 || amount > MaxAmountMinor {
		return fmt.Errorf("amount_minor %d is out of range", amount)
	}
	return nil
}

func checkText(field, value string, maxLen int) error {
	n := utf8.RuneCountInString(value)
	if n == 0 {
		return fmt.Errorf("%s is empty", field)
	}
	if n > maxLen {
		return fmt.Errorf("%s is longer than %d characters", field, maxLen)
	}
	return nil
}

func isDate(s string) bool {
	_, err := time.Parse(time.DateOnly, s)
	return err == nil && len(s) == len(time.DateOnly)
}

func isNull(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

// decodeStrict decodes one JSON object and rejects unknown fields, so that an
// action of the wrong shape (or a non-integer amount) is an error.
func decodeStrict(raw json.RawMessage, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data after the object")
	}
	return nil
}
