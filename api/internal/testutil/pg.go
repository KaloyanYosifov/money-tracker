// Package testutil has helpers for integration tests.
package testutil

import (
	"context"
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/KaloyanYosifov/money-tracker/api/internal/db"
)

// templateDB is the migrated database that each test database copies.
const templateDB = "money"

var (
	serverOnce sync.Once
	serverURL  *url.URL
	serverPool *pgxpool.Pool
	serverErr  error

	// createMu serializes CREATE DATABASE, because concurrent copies of one template can fail.
	createMu sync.Mutex
	dbCount  atomic.Int64
)

// StartPostgres returns a pool to a new database with all migrations and the
// powersync_repl role. All tests of a package share one postgres:17 container
// with logical replication, so a full run does not start a container per test.
// The pool closes and the database is dropped when the test ends.
func StartPostgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	serverOnce.Do(func() { serverErr = startServer(ctx) })
	if serverErr != nil {
		t.Fatalf("start postgres: %v", serverErr)
	}

	name := fmt.Sprintf("test_%d", dbCount.Add(1))
	createMu.Lock()
	_, err := serverPool.Exec(ctx, fmt.Sprintf("CREATE DATABASE %s TEMPLATE %s", name, templateDB))
	createMu.Unlock()
	if err != nil {
		t.Fatalf("create database %s: %v", name, err)
	}

	dbURL := *serverURL
	dbURL.Path = "/" + name
	pool, err := db.Open(ctx, dbURL.String())
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		if _, err := serverPool.Exec(context.Background(), fmt.Sprintf("DROP DATABASE %s WITH (FORCE)", name)); err != nil {
			t.Errorf("drop database %s: %v", name, err)
		}
	})
	return pool
}

// startServer starts the shared container and migrates the template database.
// The testcontainers reaper removes the container when the test binary exits.
func startServer(ctx context.Context) error {
	// The test binaries of all packages start at the same time and share one reaper container.
	// A binary can see that reaper before it runs and fail, so a failed start is tried again.
	var ctr *postgres.PostgresContainer
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		ctr, err = postgres.Run(ctx, "postgres:17",
			postgres.WithDatabase(templateDB),
			postgres.WithUsername("postgres"),
			postgres.WithPassword("postgres"),
			postgres.BasicWaitStrategies(),
			testcontainers.WithCmdArgs("-c", "wal_level=logical"),
		)
		if err == nil {
			break
		}
		_ = testcontainers.TerminateContainer(ctr)
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}
	if err != nil {
		return err
	}
	raw, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		return fmt.Errorf("connection string: %w", err)
	}
	serverURL, err = url.Parse(raw)
	if err != nil {
		return fmt.Errorf("parse connection string: %w", err)
	}

	// The admin pool uses the postgres database, because a template must have no connections.
	adminURL := *serverURL
	adminURL.Path = "/postgres"
	serverPool, err = db.Open(ctx, adminURL.String())
	if err != nil {
		return fmt.Errorf("open admin pool: %w", err)
	}
	// The migrations grant to powersync_repl, so the role must exist first.
	if _, err := serverPool.Exec(ctx, "CREATE ROLE powersync_repl LOGIN REPLICATION"); err != nil {
		return fmt.Errorf("create powersync_repl: %w", err)
	}
	if err := db.Migrate(ctx, raw); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}
