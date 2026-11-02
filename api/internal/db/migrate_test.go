package db_test

import (
	"context"
	"database/sql"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/KaloyanYosifov/money-tracker/api/internal/db"
	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

var syncedTables = []string{"accounts", "budgets", "categories", "insight_questions", "insights", "instrument_prices", "instruments", "recurring_rules", "trades", "transactions", "user_instruments", "user_settings"}

var privateTables = []string{"users", "invites", "recovery_codes", "refresh_tokens", "deleted_records", "insight_memory"}

func TestMigrationsCreateSchema(t *testing.T) {
	pool := testutil.StartPostgres(t)
	ctx := context.Background()

	for _, table := range append(slices.Clone(syncedTables), privateTables...) {
		var exists bool
		err := pool.QueryRow(ctx, "SELECT to_regclass('public.' || $1) IS NOT NULL", table).Scan(&exists)
		if err != nil {
			t.Fatalf("check table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %s does not exist", table)
		}
	}

	rows, err := pool.Query(ctx,
		"SELECT tablename FROM pg_publication_tables WHERE pubname = 'powersync' ORDER BY tablename")
	if err != nil {
		t.Fatalf("query publication: %v", err)
	}
	var published []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan publication table: %v", err)
		}
		published = append(published, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read publication tables: %v", err)
	}
	if !slices.Equal(published, syncedTables) {
		t.Errorf("publication powersync has %v, want %v", published, syncedTables)
	}

	for _, table := range syncedTables {
		if !hasPrivilege(t, pool, table, "SELECT") {
			t.Errorf("powersync_repl has no SELECT on %s", table)
		}
	}
	for _, table := range privateTables {
		if hasPrivilege(t, pool, table, "SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER") {
			t.Errorf("powersync_repl has a privilege on %s", table)
		}
	}
}

func TestMigrationsAreIdempotent(t *testing.T) {
	pool := testutil.StartPostgres(t)
	ctx := context.Background()

	before := gooseRows(t, pool)
	if err := db.Migrate(ctx, pool.Config().ConnString()); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if after := gooseRows(t, pool); after != before {
		t.Errorf("goose_db_version has %d rows after the second run, want %d", after, before)
	}
}

func hasPrivilege(t *testing.T, pool *pgxpool.Pool, table, privs string) bool {
	t.Helper()
	var ok bool
	err := pool.QueryRow(context.Background(),
		"SELECT has_table_privilege('powersync_repl', 'public.' || $1, $2)", table, privs).Scan(&ok)
	if err != nil {
		t.Fatalf("check privilege on %s: %v", table, err)
	}
	return ok
}

func gooseRows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM goose_db_version").Scan(&n); err != nil {
		t.Fatalf("count goose_db_version: %v", err)
	}
	return n
}

func TestPortfolioMigrationDownAndUp(t *testing.T) {
	pool := testutil.StartPostgres(t)
	ctx := context.Background()

	conn, err := sql.Open("pgx", pool.Config().ConnString())
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer conn.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, conn, os.DirFS("migrations"))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	if _, err := provider.DownTo(ctx, 7); err != nil {
		t.Fatalf("migrate down to 7: %v", err)
	}
	for _, table := range []string{"trades", "user_instruments", "instrument_prices", "instruments"} {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass('public.' || $1) IS NOT NULL", table).Scan(&exists); err != nil {
			t.Fatalf("check table %s: %v", table, err)
		}
		if exists {
			t.Errorf("table %s still exists after the down migration", table)
		}
	}

	if _, err := provider.Up(ctx); err != nil {
		t.Fatalf("migrate up again: %v", err)
	}
}
