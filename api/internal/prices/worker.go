package prices

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	passLimit     = 50
	chartTimeout  = 15 * time.Second
	maxFails      = 5
	maxReasonLen  = 200
	fetchEvery    = "1 hour"
	failedRetryIn = "24 hours"
)

// RunWorker runs a pass at once and then on each tick, until ctx is done.
func RunWorker(ctx context.Context, pool *pgxpool.Pool, src PriceSource, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := RunPass(ctx, pool, src, time.Now()); err != nil && ctx.Err() == nil {
			slog.Error("price worker pass failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RunPass adds the missing FX pairs and then fetches the instruments that
// are due at now, up to passLimit of them. A rate limit of the source stops
// the pass.
func RunPass(ctx context.Context, pool *pgxpool.Pool, src PriceSource, now time.Time) error {
	if err := EnsureFXPairs(ctx, pool); err != nil {
		return err
	}
	for range passLimit {
		found, err := fetchOne(ctx, pool, src, now)
		if errors.Is(err, ErrRateLimited) {
			slog.Warn("price source rate limited, pass stopped", "err", err)
			return nil
		}
		if err != nil || !found {
			return err
		}
	}
	return nil
}

// dueSQL locks one due instrument. It is due if it was never tried, if the
// last try is older than 1 hour (24 hours after 5 failures), or if a trade
// is older than its history and it has no failures.
var dueSQL = `
	WITH starts AS (SELECT i.id, ` + historyStartSQL("$2") + ` AS start FROM instruments i)
	SELECT i.id::text, i.symbol, i.name, i.exchange, i.kind, i.quote_currency, i.history_from, i.last_fetched_at, s.start
	FROM instruments i JOIN starts s ON s.id = i.id
	WHERE i.last_attempt_at IS NULL
	   OR (i.failed_at IS NULL AND i.last_attempt_at < $1::timestamptz - interval '` + fetchEvery + `')
	   OR (i.failed_at IS NOT NULL AND i.last_attempt_at < $1::timestamptz - interval '` + failedRetryIn + `')
	   OR (i.failed_at IS NULL AND i.fail_count = 0 AND s.start < i.history_from)
	ORDER BY i.last_attempt_at NULLS FIRST, i.symbol
	LIMIT 1
	FOR UPDATE OF i SKIP LOCKED`

// fetchOne fetches one due instrument. The row stays locked during the
// Chart call, so that two passes do not fetch the same instrument. It
// returns false when no instrument is due. A rate limit is not a failure of
// the instrument: fetchOne rolls back and returns the error.
func fetchOne(ctx context.Context, pool *pgxpool.Pool, src PriceSource, now time.Time) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	today := dayOf(now)
	var inst Instrument
	var historyFrom, lastFetchedAt *time.Time
	var start time.Time
	err = tx.QueryRow(ctx, dueSQL, now, today).
		Scan(&inst.ID, &inst.Symbol, &inst.Name, &inst.Exchange, &inst.Kind, &inst.QuoteCurrency, &historyFrom, &lastFetchedAt, &start)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("select due instrument: %w", err)
	}

	// Without a backfill, fetch from the last fetch, so that a pause of the
	// worker leaves no gap.
	from := today.AddDate(0, 0, -historyDays)
	if historyFrom == nil || historyFrom.After(start) {
		from = start
	} else if lastFetchedAt != nil && dayOf(*lastFetchedAt).Before(from) {
		from = dayOf(*lastFetchedAt)
	}

	chartCtx, cancel := context.WithTimeout(ctx, chartTimeout)
	chart, err := src.Chart(chartCtx, inst.Symbol, from)
	cancel()
	if ctx.Err() != nil {
		return true, ctx.Err()
	}
	if errors.Is(err, ErrRateLimited) {
		return true, err
	}
	if err != nil {
		slog.Warn("price fetch failed", "symbol", inst.Symbol, "err", err)
		if err := recordFailure(ctx, tx, inst.ID, err, now); err != nil {
			return true, err
		}
		return true, commit(ctx, tx)
	}

	if err := SavePrices(ctx, tx, inst.ID, chart); err != nil {
		// The transaction is aborted, so record the failure outside it.
		slog.Warn("price fetch failed", "symbol", inst.Symbol, "err", err)
		_ = tx.Rollback(ctx)
		return true, recordFailure(ctx, pool, inst.ID, err, now)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE instruments
		 SET last_fetched_at = $2, last_attempt_at = $2, fail_count = 0, failed_at = NULL, fail_reason = NULL,
		     history_from = LEAST(COALESCE(history_from, $3), $3), updated_at = now()
		 WHERE id = $1`, inst.ID, now, from); err != nil {
		return true, fmt.Errorf("update %s: %w", inst.Symbol, err)
	}
	return true, commit(ctx, tx)
}

// recordFailure counts a failed fetch. The fifth failure in a row sets
// failed_at.
func recordFailure(ctx context.Context, db DB, id string, cause error, now time.Time) error {
	reason := []rune(cause.Error())
	if len(reason) > maxReasonLen {
		reason = reason[:maxReasonLen]
	}
	_, err := db.Exec(ctx,
		`UPDATE instruments
		 SET fail_count = fail_count + 1, fail_reason = $2, last_attempt_at = $3,
		     failed_at = CASE WHEN fail_count + 1 >= $4 THEN COALESCE(failed_at, $3) END,
		     updated_at = now()
		 WHERE id = $1`, id, string(reason), now, maxFails)
	if err != nil {
		return fmt.Errorf("record failure: %w", err)
	}
	return nil
}

func commit(ctx context.Context, tx pgx.Tx) error {
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}
