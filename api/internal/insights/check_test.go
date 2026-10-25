package insights_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/KaloyanYosifov/money-tracker/api/internal/insights"
)

const (
	foodID     = "11111111-1111-4111-8111-111111111111"
	salaryID   = "22222222-2222-4222-8222-222222222222"
	archivedID = "33333333-3333-4333-8333-333333333333"
	unknownID  = "44444444-4444-4444-8444-444444444444"
	accountID  = "55555555-5555-4555-8555-555555555555"
)

var data = insights.UserData{
	Categories: []insights.Category{
		{ID: foodID, Type: "expense"},
		{ID: salaryID, Type: "income"},
		{ID: archivedID, Type: "expense", Archived: true},
	},
	Budgets: []insights.CategoryBudget{{CategoryID: foodID, AmountMinor: 30000}},
}

func card(kind, action string) insights.Card {
	c := insights.Card{Kind: kind, Title: "Title", Body: "Body", Fingerprint: "fp"}
	if action != "" {
		c.Action = json.RawMessage(action)
	}
	return c
}

func recurring(fields string) string {
	return `{"type":"expense","category_id":"` + foodID + `","amount_minor":1500,` +
		`"frequency":"monthly","start_date":"2026-11-01","name":"Gym"` + fields + `}`
}

func TestCheckCard(t *testing.T) {
	maxPlusOne := `{"category_id":"` + foodID + `","amount_minor":1000000000001}`
	cases := []struct {
		name  string
		card  insights.Card
		valid bool
	}{
		{"tip with no action", card("tip", ""), true},
		{"tip with null action", card("tip", "null"), true},
		{"tip with an action", card("tip", `{"category_id":"`+foodID+`","amount_minor":100}`), false},
		{"budget for an expense category", card("budget", `{"category_id":"`+foodID+`","amount_minor":25000}`), true},
		{"budget at the max amount", card("budget", `{"category_id":"`+foodID+`","amount_minor":1000000000000}`), true},
		{"budget with no action", card("budget", ""), false},
		{"budget for an unknown category", card("budget", `{"category_id":"`+unknownID+`","amount_minor":100}`), false},
		{"budget for an archived category", card("budget", `{"category_id":"`+archivedID+`","amount_minor":100}`), false},
		{"budget for an income category", card("budget", `{"category_id":"`+salaryID+`","amount_minor":100}`), false},
		{"budget with zero amount", card("budget", `{"category_id":"`+foodID+`","amount_minor":0}`), false},
		{"budget with a negative amount", card("budget", `{"category_id":"`+foodID+`","amount_minor":-5}`), false},
		{"budget with a non-integer amount", card("budget", `{"category_id":"`+foodID+`","amount_minor":12.5}`), false},
		{"budget with a string amount", card("budget", `{"category_id":"`+foodID+`","amount_minor":"100"}`), false},
		{"budget above the max amount", card("budget", maxPlusOne), false},
		{"budget with a recurring rule action", card("budget", recurring("")), false},
		{"recurring expense rule", card("recurring_rule", recurring("")), true},
		{"recurring income rule", card("recurring_rule", `{"type":"income","category_id":"`+salaryID+
			`","amount_minor":500000,"frequency":"monthly","start_date":"2026-11-25","name":"Salary"}`), true},
		{"recurring rule with optional fields", card("recurring_rule", recurring(
			`,"account_id":"`+accountID+`","end_date":"2027-11-01","note":"Yearly contract"`)), true},
		{"recurring rule with null optional fields", card("recurring_rule", recurring(
			`,"account_id":null,"end_date":null,"note":null`)), true},
		{"recurring rule for an unknown category", card("recurring_rule", strings.Replace(recurring(""), foodID, unknownID, 1)), false},
		{"recurring rule for an archived category", card("recurring_rule", strings.Replace(recurring(""), foodID, archivedID, 1)), false},
		{"recurring rule with a category of the other type", card("recurring_rule", strings.Replace(recurring(""), foodID, salaryID, 1)), false},
		{"recurring transfer", card("recurring_rule", strings.Replace(recurring(""), `"expense"`, `"transfer"`, 1)), false},
		{"recurring rule with a bad frequency", card("recurring_rule", strings.Replace(recurring(""), "monthly", "hourly", 1)), false},
		{"recurring rule with zero amount", card("recurring_rule", strings.Replace(recurring(""), "1500", "0", 1)), false},
		{"recurring rule with a bad start date", card("recurring_rule", strings.Replace(recurring(""), "2026-11-01", "01.11.2026", 1)), false},
		{"recurring rule with an impossible start date", card("recurring_rule", strings.Replace(recurring(""), "2026-11-01", "2026-02-30", 1)), false},
		{"recurring rule that ends before it starts", card("recurring_rule", recurring(`,"end_date":"2026-10-01"`)), false},
		{"recurring rule with a long name", card("recurring_rule", strings.Replace(recurring(""), "Gym", strings.Repeat("n", 121), 1)), false},
		{"recurring rule with a budget action", card("recurring_rule", `{"category_id":"`+foodID+`","amount_minor":100}`), false},
		{"recurring rule with an unknown field", card("recurring_rule", recurring(`,"to_account_id":"`+accountID+`"`)), false},
		{"unknown kind", card("loan", ""), false},
		{"title of 80 characters", insights.Card{Kind: "tip", Title: strings.Repeat("t", 80), Body: "b", Fingerprint: "fp"}, true},
		{"title over 80 characters", insights.Card{Kind: "tip", Title: strings.Repeat("t", 81), Body: "b", Fingerprint: "fp"}, false},
		{"body of 500 characters", insights.Card{Kind: "tip", Title: "t", Body: strings.Repeat("b", 500), Fingerprint: "fp"}, true},
		{"body over 500 characters", insights.Card{Kind: "tip", Title: "t", Body: strings.Repeat("b", 501), Fingerprint: "fp"}, false},
		{"empty title", insights.Card{Kind: "tip", Body: "b", Fingerprint: "fp"}, false},
		{"empty fingerprint", insights.Card{Kind: "tip", Title: "t", Body: "b"}, false},
		{"fingerprint over 200 characters", insights.Card{Kind: "tip", Title: "t", Body: "b", Fingerprint: strings.Repeat("f", 201)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := insights.CheckCard(tc.card, data)
			if tc.valid && err != nil {
				t.Fatalf("CheckCard: want valid, got %v", err)
			}
			if !tc.valid && err == nil {
				t.Fatal("CheckCard: want an error, got nil")
			}
		})
	}
}

func TestCheckCardErrorNamesTheReason(t *testing.T) {
	err := insights.CheckCard(card("budget", `{"category_id":"`+salaryID+`","amount_minor":100}`), data)
	if err == nil || !strings.Contains(err.Error(), "category") {
		t.Fatalf("want an error about the category, got %v", err)
	}
}

func TestCheckAnswerAction(t *testing.T) {
	cases := []struct {
		name   string
		action json.RawMessage
		valid  bool
	}{
		{"no action", nil, true},
		{"null action", json.RawMessage("null"), true},
		{"budget action", json.RawMessage(`{"category_id":"` + foodID + `","amount_minor":25000}`), true},
		{"recurring rule action", json.RawMessage(recurring("")), true},
		{"budget action for an income category", json.RawMessage(`{"category_id":"` + salaryID + `","amount_minor":100}`), false},
		{"budget action with zero amount", json.RawMessage(`{"category_id":"` + foodID + `","amount_minor":0}`), false},
		{"recurring rule action with a bad frequency", json.RawMessage(strings.Replace(recurring(""), "monthly", "hourly", 1)), false},
		{"recurring rule action for an unknown category", json.RawMessage(strings.Replace(recurring(""), foodID, unknownID, 1)), false},
		{"an action that is not an object", json.RawMessage(`"budget"`), false},
		{"an action of unknown shape", json.RawMessage(`{"foo":1}`), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := insights.CheckAnswerAction(tc.action, data)
			if tc.valid && err != nil {
				t.Fatalf("CheckAnswerAction: want valid, got %v", err)
			}
			if !tc.valid && err == nil {
				t.Fatal("CheckAnswerAction: want an error, got nil")
			}
		})
	}
}
