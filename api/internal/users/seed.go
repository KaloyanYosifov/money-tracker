package users

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type defaultCategory struct {
	kind, name, icon, color string
}

// The icon values are keys of the app icon registry (app/src/ui/icons/categoryIcons.tsx).
var defaultCategories = []defaultCategory{
	{"expense", "Eating Out", "fork", "#e8743b"},
	{"expense", "Shopping", "cart", "#d6457a"},
	{"expense", "Groceries", "groceries", "#5aa454"},
	{"expense", "Entertainment", "music", "#8e5cc4"},
	{"expense", "Travel", "bus", "#2f8fd8"},
	{"expense", "Service", "flame", "#f2a33a"},
	{"expense", "Tax", "tax", "#7a6a58"},
	{"expense", "Gifts", "gift", "#e35d6a"},
	{"expense", "Rent", "key", "#a0522d"},
	{"expense", "Bills", "calculator", "#4b7bbf"},
	{"expense", "Education", "book", "#3aa6a0"},
	{"expense", "General", "tag", "#8a8a8a"},
	{"income", "Salary", "piggy", "#3b9d3b"},
	{"income", "Other income", "coins", "#c9a227"},
}

type defaultAccount struct {
	name, color string
}

var defaultAccounts = []defaultAccount{
	{"Wallet", "#8a5a44"},
	{"Bank", "#1d4f9a"},
}

// SeedDefaults creates the settings, the default categories and the default
// accounts of a new user inside tx. If the user already has settings,
// SeedDefaults does nothing.
func SeedDefaults(ctx context.Context, tx pgx.Tx, userID, currency string) error {
	tag, err := tx.Exec(ctx,
		`INSERT INTO user_settings
		   (id, user_id, currency_code, time_period, week_start_day, month_start_day, year_start_month,
		    budget_mode, carry_over, hide_future, show_note, theme, summary_font, icon_style)
		 VALUES (gen_random_uuid(), $1, $2, 'monthly', 1, 1, 1,
		         false, true, false, true, 'system', 'mono', 'filled')
		 ON CONFLICT (user_id) DO NOTHING`, userID, currency)
	if err != nil {
		return fmt.Errorf("insert user settings: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil
	}

	for i, c := range defaultCategories {
		_, err := tx.Exec(ctx,
			`INSERT INTO categories (id, user_id, type, name, icon, color, sort_order)
			 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
			userID, c.kind, c.name, c.icon, c.color, i)
		if err != nil {
			return fmt.Errorf("insert category %s: %w", c.name, err)
		}
	}
	for i, a := range defaultAccounts {
		_, err := tx.Exec(ctx,
			`INSERT INTO accounts (id, user_id, name, color, sort_order)
			 VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
			userID, a.name, a.color, i)
		if err != nil {
			return fmt.Errorf("insert account %s: %w", a.name, err)
		}
	}
	return nil
}
