package users_test

import (
	"context"
	"regexp"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

// iconKeys is a copy of the app icon registry keys (app/src/ui/icons/categoryIcons.tsx).
var iconKeys = []string{
	"fork", "cart", "groceries", "music", "bus", "flame", "tax", "gift", "key",
	"calculator", "book", "tag", "piggy", "coins", "car", "home", "health",
	"phone", "coffee", "plane", "baby", "shirt", "sport", "pet",
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func seed(t *testing.T, pool *pgxpool.Pool, userID, currency string) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := users.SeedDefaults(ctx, tx, userID, currency); err != nil {
		t.Fatalf("SeedDefaults: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestSeedDefaults(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	var userID string
	err := pool.QueryRow(ctx,
		`INSERT INTO users (id, email, password_hash, role)
		 VALUES (gen_random_uuid(), 'a@example.com', 'x', 'user') RETURNING id::text`).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}

	seed(t, pool, userID, "EUR")

	var (
		currency, timePeriod, theme, summaryFont, iconStyle   string
		weekStart, monthStart, yearStart                      int
		budgetMode, carryOver, hideFuture, showNote, insights bool
	)
	err = pool.QueryRow(ctx,
		`SELECT currency_code, time_period, week_start_day, month_start_day, year_start_month,
		        budget_mode, carry_over, hide_future, show_note, theme, summary_font, icon_style, insights_enabled
		 FROM user_settings WHERE user_id = $1`, userID).
		Scan(&currency, &timePeriod, &weekStart, &monthStart, &yearStart,
			&budgetMode, &carryOver, &hideFuture, &showNote, &theme, &summaryFont, &iconStyle, &insights)
	if err != nil {
		t.Fatalf("read user_settings: %v", err)
	}
	if currency != "EUR" || timePeriod != "monthly" || weekStart != 1 || monthStart != 1 || yearStart != 1 ||
		budgetMode || !carryOver || hideFuture || !showNote ||
		theme != "system" || summaryFont != "mono" || iconStyle != "filled" || insights {
		t.Fatalf("user_settings defaults are wrong: %v %v %v %v %v %v %v %v %v %v %v %v %v",
			currency, timePeriod, weekStart, monthStart, yearStart,
			budgetMode, carryOver, hideFuture, showNote, theme, summaryFont, iconStyle, insights)
	}

	rows, err := pool.Query(ctx,
		`SELECT type, name, icon, color FROM categories WHERE user_id = $1 ORDER BY type, sort_order`, userID)
	if err != nil {
		t.Fatal(err)
	}
	var expense, income []string
	for rows.Next() {
		var typ, name, icon, color string
		if err := rows.Scan(&typ, &name, &icon, &color); err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(iconKeys, icon) {
			t.Errorf("category %q uses icon %q, which is not in the registry", name, icon)
		}
		if !hexColor.MatchString(color) {
			t.Errorf("category %q has color %q", name, color)
		}
		switch typ {
		case "expense":
			expense = append(expense, name)
		case "income":
			income = append(income, name)
		default:
			t.Errorf("category %q has type %q", name, typ)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	wantExpense := []string{"Eating Out", "Shopping", "Groceries", "Entertainment", "Travel", "Service",
		"Tax", "Gifts", "Rent", "Bills", "Education", "General"}
	if !slices.Equal(expense, wantExpense) {
		t.Fatalf("expense categories = %v, want %v", expense, wantExpense)
	}
	if want := []string{"Salary", "Other income"}; !slices.Equal(income, want) {
		t.Fatalf("income categories = %v, want %v", income, want)
	}

	rows, err = pool.Query(ctx, `SELECT name, color FROM accounts WHERE user_id = $1 ORDER BY sort_order`, userID)
	if err != nil {
		t.Fatal(err)
	}
	var accounts []string
	for rows.Next() {
		var name, color string
		if err := rows.Scan(&name, &color); err != nil {
			t.Fatal(err)
		}
		if !hexColor.MatchString(color) {
			t.Errorf("account %q has color %q", name, color)
		}
		accounts = append(accounts, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"Wallet", "Bank"}; !slices.Equal(accounts, want) {
		t.Fatalf("accounts = %v, want %v", accounts, want)
	}

	seed(t, pool, userID, "USD")

	var settings, categories, accountCount int
	err = pool.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM user_settings WHERE user_id = $1),
		        (SELECT count(*) FROM categories WHERE user_id = $1),
		        (SELECT count(*) FROM accounts WHERE user_id = $1)`, userID).
		Scan(&settings, &categories, &accountCount)
	if err != nil {
		t.Fatal(err)
	}
	if settings != 1 || categories != 14 || accountCount != 2 {
		t.Fatalf("after a second call: %d settings, %d categories, %d accounts; want 1, 14, 2",
			settings, categories, accountCount)
	}
	if err := pool.QueryRow(ctx, `SELECT currency_code FROM user_settings WHERE user_id = $1`, userID).Scan(&currency); err != nil {
		t.Fatal(err)
	}
	if currency != "EUR" {
		t.Fatalf("currency after a second call = %q, want EUR", currency)
	}
}
