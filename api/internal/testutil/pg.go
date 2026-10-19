// Package testutil has helpers for integration tests.
package testutil

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/KaloyanYosifov/money-tracker/api/internal/db"
)

// StartPostgres starts a postgres:17 container with logical replication,
// creates the powersync_repl role, runs all migrations and returns a pool.
// The container and the pool are closed when the test ends.
func StartPostgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	ctr, err := postgres.Run(ctx, "postgres:17",
		postgres.WithDatabase("money"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(),
		testcontainers.WithCmdArgs("-c", "wal_level=logical"),
	)
	testcontainers.CleanupContainer(t, ctr)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}

	url, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("connection string: %v", err)
	}

	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := pool.Exec(ctx, "CREATE ROLE powersync_repl LOGIN REPLICATION"); err != nil {
		t.Fatalf("create powersync_repl: %v", err)
	}
	if err := db.Migrate(ctx, url); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}
