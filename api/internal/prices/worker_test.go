package prices

import (
	"context"
	"errors"
	"fmt"
	"strings"
	gosync "sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/testutil"
)

type chartCall struct {
	symbol string
	from   time.Time
}

// recordingSource records the Chart calls. fail gives the error for a
// symbol, and a symbol with no error gets a close of 100 for each day from
// from to latestAt.
type recordingSource struct {
	mu       gosync.Mutex
	calls    []chartCall
	fail     map[string]error
	latestAt time.Time
	before   func()
}

func (s *recordingSource) Search(context.Context, string) ([]Match, error) {
	return nil, errors.New("not used in the worker tests")
}

func (s *recordingSource) Chart(_ context.Context, symbol string, from time.Time) (Chart, error) {
	s.mu.Lock()
	s.calls = append(s.calls, chartCall{symbol, from})
	err := s.fail[symbol]
	s.mu.Unlock()
	if s.before != nil {
		s.before()
	}
	if err != nil {
		return Chart{}, err
	}
	c := Chart{Symbol: symbol, Currency: "USD", Latest: "100", LatestAt: s.latestAt}
	for d := dayOf(from); !d.After(dayOf(s.latestAt)); d = d.AddDate(0, 0, 1) {
		c.Closes = append(c.Closes, DailyClose{Date: d, Close: "100"})
	}
	return c, nil
}

func (s *recordingSource) callsFor(symbol string) []chartCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []chartCall
	for _, c := range s.calls {
		if c.symbol == symbol {
			out = append(out, c)
		}
	}
	return out
}

type instrumentState struct {
	LastFetchedAt *time.Time
	LastAttemptAt *time.Time
	HistoryFrom   *time.Time
	FailCount     int
	FailedAt      *time.Time
	FailReason    *string
}

func readState(t *testing.T, pool *pgxpool.Pool, symbol string) instrumentState {
	t.Helper()
	var s instrumentState
	err := pool.QueryRow(context.Background(),
		`SELECT last_fetched_at, last_attempt_at, history_from, fail_count, failed_at, fail_reason
		 FROM instruments WHERE symbol = $1`, symbol).
		Scan(&s.LastFetchedAt, &s.LastAttemptAt, &s.HistoryFrom, &s.FailCount, &s.FailedAt, &s.FailReason)
	if err != nil {
		t.Fatalf("read %s: %v", symbol, err)
	}
	return s
}

func priceRows(t *testing.T, pool *pgxpool.Pool, symbol string) int {
	t.Helper()
	return countRows(t, pool,
		`SELECT count(*) FROM instrument_prices p JOIN instruments i ON i.id = p.instrument_id WHERE i.symbol = $1`, symbol)
}

func sameTime(a *time.Time, b time.Time) bool { return a != nil && a.Equal(b) }

func dateString(d *time.Time) string {
	if d == nil {
		return "<nil>"
	}
	return d.Format(time.DateOnly)
}

func TestRunPass(t *testing.T) {
	ctx := context.Background()
	pool := testutil.StartPostgres(t)
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	weekAgo := "2026-10-13"

	reset := func(t *testing.T) {
		execSQL(t, pool, `DELETE FROM trades`)
		execSQL(t, pool, `DELETE FROM user_instruments`)
		execSQL(t, pool, `DELETE FROM instrument_prices`)
		execSQL(t, pool, `DELETE FROM instruments`)
	}
	// seed sets the worker state of an instrument.
	seed := func(t *testing.T, symbol string, lastAttempt time.Time, historyFrom string, failCount int) string {
		t.Helper()
		id := addInstrument(t, pool, symbol, KindStock, "USD")
		execSQL(t, pool,
			`UPDATE instruments SET last_attempt_at = $2, last_fetched_at = $2, history_from = $3, fail_count = $4
			 WHERE id = $1`, id, lastAttempt, historyFrom, failCount)
		return id
	}
	run := func(t *testing.T, src *recordingSource, at time.Time) {
		t.Helper()
		src.latestAt = at
		if err := RunPass(ctx, pool, src, at); err != nil {
			t.Fatalf("RunPass: %v", err)
		}
	}

	t.Run("a new instrument is fetched", func(t *testing.T) {
		reset(t)
		addInstrument(t, pool, "ZZNW", KindStock, "USD")
		src := &recordingSource{}
		run(t, src, now)

		calls := src.callsFor("ZZNW")
		if len(calls) != 1 {
			t.Fatalf("calls = %+v, want 1", calls)
		}
		if priceRows(t, pool, "ZZNW") == 0 {
			t.Error("no price rows")
		}
		s := readState(t, pool, "ZZNW")
		if !sameTime(s.LastFetchedAt, now) || !sameTime(s.LastAttemptAt, now) || s.FailCount != 0 {
			t.Errorf("state = %+v", s)
		}
		if got, want := dateString(s.HistoryFrom), calls[0].from.Format(time.DateOnly); got != want || want != weekAgo {
			t.Errorf("history_from = %s, from = %s, want %s", got, want, weekAgo)
		}
	})

	t.Run("an instrument fetched 30 minutes ago is not due", func(t *testing.T) {
		reset(t)
		seed(t, "ZZRC", now.Add(-30*time.Minute), weekAgo, 0)
		src := &recordingSource{}
		run(t, src, now)
		if len(src.calls) != 0 {
			t.Errorf("calls = %+v, want none", src.calls)
		}
	})

	t.Run("an instrument fetched 61 minutes ago is due", func(t *testing.T) {
		reset(t)
		seed(t, "ZZOL", now.Add(-61*time.Minute), "2026-01-01", 0)
		src := &recordingSource{}
		run(t, src, now)
		calls := src.callsFor("ZZOL")
		if len(calls) != 1 || calls[0].from.Format(time.DateOnly) != weekAgo {
			t.Fatalf("calls = %+v, want one from %s", calls, weekAgo)
		}
		if s := readState(t, pool, "ZZOL"); dateString(s.HistoryFrom) != "2026-01-01" || !sameTime(s.LastFetchedAt, now) {
			t.Errorf("state = %+v, want history_from 2026-01-01", s)
		}
	})

	t.Run("an instrument last fetched 20 days ago is fetched from that date", func(t *testing.T) {
		reset(t)
		seed(t, "ZZGP", now.AddDate(0, 0, -20), "2026-01-01", 0)
		src := &recordingSource{}
		run(t, src, now)
		calls := src.callsFor("ZZGP")
		if len(calls) != 1 || calls[0].from.Format(time.DateOnly) != "2026-09-30" {
			t.Fatalf("calls = %+v, want one from 2026-09-30", calls)
		}
		if s := readState(t, pool, "ZZGP"); dateString(s.HistoryFrom) != "2026-01-01" {
			t.Errorf("history_from = %s, want 2026-01-01", dateString(s.HistoryFrom))
		}
	})

	t.Run("an older trade starts a backfill", func(t *testing.T) {
		reset(t)
		id := seed(t, "ZZBF", now.Add(-10*time.Minute), weekAgo, 0)
		addTrade(t, pool, newUser(t, pool, "USD"), id, "2026-05-04")
		src := &recordingSource{}
		run(t, src, now)
		calls := src.callsFor("ZZBF")
		if len(calls) != 1 || calls[0].from.Format(time.DateOnly) != "2026-05-04" {
			t.Fatalf("calls = %+v, want one from 2026-05-04", calls)
		}
		if s := readState(t, pool, "ZZBF"); dateString(s.HistoryFrom) != "2026-05-04" {
			t.Errorf("history_from = %s, want 2026-05-04", dateString(s.HistoryFrom))
		}
	})

	t.Run("a failure counts", func(t *testing.T) {
		reset(t)
		lastFetch := now.Add(-2 * time.Hour)
		seed(t, "ZZFL", lastFetch, weekAgo, 0)
		src := &recordingSource{fail: map[string]error{"ZZFL": errors.New("upstream: " + strings.Repeat("x", 500))}}
		run(t, src, now)

		s := readState(t, pool, "ZZFL")
		if s.FailCount != 1 || !sameTime(s.LastAttemptAt, now) || !sameTime(s.LastFetchedAt, lastFetch) || s.FailedAt != nil {
			t.Errorf("state = %+v", s)
		}
		if s.FailReason == nil || *s.FailReason == "" || len([]rune(*s.FailReason)) > 200 {
			t.Errorf("fail_reason = %v, want 1 to 200 characters", s.FailReason)
		}

		run(t, src, now.Add(10*time.Minute))
		if n := len(src.callsFor("ZZFL")); n != 1 {
			t.Errorf("calls = %d, want 1 (no call 10 minutes later)", n)
		}
	})

	t.Run("five failures set failed_at", func(t *testing.T) {
		reset(t)
		seed(t, "ZZ5F", now.Add(-2*time.Hour), weekAgo, 4)
		src := &recordingSource{fail: map[string]error{"ZZ5F": errors.New("upstream down")}}
		run(t, src, now)
		if s := readState(t, pool, "ZZ5F"); s.FailCount != 5 || !sameTime(s.FailedAt, now) {
			t.Fatalf("state = %+v, want fail_count 5 and failed_at now", s)
		}

		run(t, src, now.Add(2*time.Hour))
		if n := len(src.callsFor("ZZ5F")); n != 1 {
			t.Fatalf("calls = %d, want 1 (no call 2 hours later)", n)
		}

		src.fail = nil
		later := now.Add(25 * time.Hour)
		run(t, src, later)
		if n := len(src.callsFor("ZZ5F")); n != 2 {
			t.Fatalf("calls = %d, want 2 (a call 25 hours later)", n)
		}
		s := readState(t, pool, "ZZ5F")
		if s.FailCount != 0 || s.FailedAt != nil || s.FailReason != nil || !sameTime(s.LastFetchedAt, later) {
			t.Errorf("state = %+v, want the failure state reset", s)
		}
	})

	t.Run("one failure does not stop the pass", func(t *testing.T) {
		reset(t)
		addInstrument(t, pool, "ZZA1", KindStock, "USD")
		addInstrument(t, pool, "ZZA2", KindStock, "USD")
		src := &recordingSource{fail: map[string]error{"ZZA1": errors.New("upstream down")}}
		run(t, src, now)
		if len(src.callsFor("ZZA1")) != 1 || readState(t, pool, "ZZA1").FailCount != 1 {
			t.Errorf("ZZA1 calls = %d, want 1 failed call", len(src.callsFor("ZZA1")))
		}
		if priceRows(t, pool, "ZZA2") == 0 {
			t.Error("ZZA2 has no prices")
		}
	})

	t.Run("a rate limit stops the pass without a failure", func(t *testing.T) {
		reset(t)
		lastFetch := now.Add(-2 * time.Hour)
		seed(t, "ZZR1", lastFetch, weekAgo, 4)
		seed(t, "ZZR2", lastFetch, weekAgo, 0)
		src := &recordingSource{fail: map[string]error{
			"ZZR1": fmt.Errorf("chart: %w", ErrRateLimited),
			"ZZR2": fmt.Errorf("chart: %w", ErrRateLimited),
		}}
		run(t, src, now)

		if len(src.calls) != 1 {
			t.Fatalf("calls = %+v, want 1", src.calls)
		}
		for _, symbol := range []string{"ZZR1", "ZZR2"} {
			s := readState(t, pool, symbol)
			if s.FailedAt != nil || s.FailReason != nil || !sameTime(s.LastAttemptAt, lastFetch) {
				t.Errorf("%s state = %+v, want no change", symbol, s)
			}
		}
		if s := readState(t, pool, "ZZR1"); s.FailCount != 4 {
			t.Errorf("ZZR1 fail_count = %d, want 4", s.FailCount)
		}
	})

	t.Run("two passes at the same time fetch each instrument once", func(t *testing.T) {
		reset(t)
		addInstrument(t, pool, "ZZC1", KindStock, "USD")
		addInstrument(t, pool, "ZZC2", KindStock, "USD")
		// Each call waits until a second call started, so both passes hold
		// one locked instrument at the same time.
		var mu gosync.Mutex
		started, timedOut := 0, false
		both := make(chan struct{})
		src := &recordingSource{latestAt: now, before: func() {
			mu.Lock()
			if started++; started == 2 {
				close(both)
			}
			mu.Unlock()
			select {
			case <-both:
			case <-time.After(5 * time.Second):
				mu.Lock()
				timedOut = true
				mu.Unlock()
			}
		}}
		var wg gosync.WaitGroup
		errs := make([]error, 2)
		for n := range 2 {
			wg.Go(func() { errs[n] = RunPass(ctx, pool, src, now) })
		}
		wg.Wait()
		for _, err := range errs {
			if err != nil {
				t.Fatalf("RunPass: %v", err)
			}
		}
		if timedOut {
			t.Error("the two passes did not fetch at the same time")
		}
		for _, symbol := range []string{"ZZC1", "ZZC2"} {
			if n := len(src.callsFor(symbol)); n != 1 {
				t.Errorf("%s calls = %d, want 1", symbol, n)
			}
		}
	})

	t.Run("the pass adds FX pairs", func(t *testing.T) {
		reset(t)
		id := addInstrument(t, pool, "ZZFX", KindStock, "USD")
		addTrade(t, pool, newUser(t, pool, "EUR"), id, "2026-09-01")
		src := &recordingSource{}
		run(t, src, now)
		if len(src.callsFor("EURUSD=X")) != 1 || priceRows(t, pool, "EURUSD=X") == 0 {
			t.Errorf("EURUSD=X calls = %d, prices = %d", len(src.callsFor("EURUSD=X")), priceRows(t, pool, "EURUSD=X"))
		}
	})
}
