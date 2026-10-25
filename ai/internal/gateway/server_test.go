package gateway

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRunner returns a fixed result and records the calls.
type fakeRunner struct {
	stdout []byte
	err    error

	mu    sync.Mutex
	calls int
	args  []string
	stdin string
}

func (f *fakeRunner) Run(ctx context.Context, args []string, stdin string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.args = args
	f.stdin = stdin
	return f.stdout, f.err
}

func okEnvelope(structured string) []byte {
	return []byte(`{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":` + structured + `}`)
}

func newTestServer(t *testing.T, runner Runner, fake bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(New(runner, fake, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	return srv
}

func post(t *testing.T, srv *httptest.Server, task, body string) (int, string) {
	t.Helper()
	resp, err := http.Post(srv.URL+"/v1/tasks/"+task, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, strings.TrimSpace(string(b))
}

func assertJSONEqual(t *testing.T, got, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal([]byte(got), &g); err != nil {
		t.Fatalf("body %q is not JSON: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	gb, _ := json.Marshal(g)
	wb, _ := json.Marshal(w)
	if string(gb) != string(wb) {
		t.Errorf("body = %s, want %s", gb, wb)
	}
}

func TestTaskReturnsStructuredOutput(t *testing.T) {
	cases := map[string]string{
		"daily_insights":    `{"cards":[{"kind":"tip","title":"T","body":"B","fingerprint":"f","action":null}],"summary":"S"}`,
		"category_question": `{"answer":"A","action":null}`,
	}
	for task, out := range cases {
		t.Run(task, func(t *testing.T) {
			runner := &fakeRunner{stdout: okEnvelope(out)}
			srv := newTestServer(t, runner, false)

			status, body := post(t, srv, task, `{"category":{"name":"Food"}}`)
			if status != http.StatusOK {
				t.Fatalf("status = %d, body %s", status, body)
			}
			assertJSONEqual(t, body, out)
			if runner.calls != 1 {
				t.Fatalf("runner calls = %d, want 1", runner.calls)
			}
			if got := flagValue(t, runner.args, "--json-schema"); got != tasks[task].Schema {
				t.Errorf("runner got schema %q, want the %s schema", got, task)
			}
			if !strings.Contains(runner.stdin, `"name": "Food"`) {
				t.Errorf("stdin %q does not carry the request data", runner.stdin)
			}
		})
	}
}

func TestTaskIgnoresResultWhenStructuredOutputIsMissing(t *testing.T) {
	runner := &fakeRunner{stdout: []byte("banner\n" + `{"type":"result","is_error":false,"result":"{\"answer\":\"A\",\"action\":null}"}`)}
	srv := newTestServer(t, runner, false)

	status, body := post(t, srv, "category_question", `{}`)
	if status != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502, body %s", status, body)
	}
	assertJSONEqual(t, body, `{"error":"bad_output"}`)
}

func TestUnknownTask(t *testing.T) {
	runner := &fakeRunner{stdout: okEnvelope(`{}`)}
	srv := newTestServer(t, runner, false)

	status, _ := post(t, srv, "write_poem", `{}`)
	if status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", status)
	}
	if runner.calls != 0 {
		t.Fatalf("runner calls = %d, want 0", runner.calls)
	}
}

func TestInvalidBody(t *testing.T) {
	runner := &fakeRunner{stdout: okEnvelope(`{}`)}
	srv := newTestServer(t, runner, false)

	status, body := post(t, srv, "daily_insights", `{"a":`)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	assertJSONEqual(t, body, `{"error":"bad_request"}`)
	if runner.calls != 0 {
		t.Fatalf("runner calls = %d, want 0", runner.calls)
	}
}

func TestRunnerErrors(t *testing.T) {
	cases := []struct {
		name   string
		runner *fakeRunner
		code   string
	}{
		{"auth error", &fakeRunner{err: ErrAuth}, "auth"},
		{"auth envelope", &fakeRunner{stdout: []byte(`{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}`)}, "auth"},
		{"timeout", &fakeRunner{err: ErrTimeout}, "timeout"},
		{"deadline", &fakeRunner{err: context.DeadlineExceeded}, "timeout"},
		{"rate limited", &fakeRunner{err: ErrRateLimited}, "rate_limited"},
		{"rate limit envelope", &fakeRunner{stdout: []byte(`{"type":"result","is_error":true,"result":"API Error: 429 rate_limit_error"}`)}, "rate_limited"},
		{"result not JSON", &fakeRunner{stdout: []byte(`{"type":"result","is_error":false,"result":"Sure! Here are your tips."}`)}, "bad_output"},
		{"no envelope", &fakeRunner{stdout: []byte(`not json at all`)}, "bad_output"},
		{"other failure", &fakeRunner{stdout: []byte(`{"type":"result","is_error":true,"result":"something broke"}`)}, "failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := newTestServer(t, c.runner, false)
			status, body := post(t, srv, "daily_insights", `{}`)
			if status != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502", status)
			}
			assertJSONEqual(t, body, `{"error":"`+c.code+`"}`)
		})
	}
}

func TestFakeMode(t *testing.T) {
	runner := &fakeRunner{err: ErrAuth}
	srv := newTestServer(t, runner, true)

	status, body := post(t, srv, "daily_insights", `{}`)
	if status != http.StatusOK {
		t.Fatalf("daily_insights status = %d, body %s", status, body)
	}
	var daily struct {
		Cards   []map[string]any `json:"cards"`
		Summary string           `json:"summary"`
	}
	if err := json.Unmarshal([]byte(body), &daily); err != nil {
		t.Fatal(err)
	}
	if len(daily.Cards) != 1 || daily.Summary == "" {
		t.Errorf("canned daily_insights = %s, want one card and a summary", body)
	}

	status, body = post(t, srv, "category_question", `{}`)
	if status != http.StatusOK {
		t.Fatalf("category_question status = %d, body %s", status, body)
	}
	var answer struct {
		Answer string `json:"answer"`
	}
	if err := json.Unmarshal([]byte(body), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Answer == "" {
		t.Errorf("canned category_question = %s, want an answer", body)
	}

	if runner.calls != 0 {
		t.Fatalf("runner calls = %d, want 0 in fake mode", runner.calls)
	}
}

func TestHealthz(t *testing.T) {
	srv := newTestServer(t, &fakeRunner{}, false)
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

// blockingRunner holds each call until release is closed, and records the
// highest number of calls that ran at the same time.
type blockingRunner struct {
	started  chan struct{}
	release  chan struct{}
	inFlight atomic.Int32
	maxSeen  atomic.Int32
}

func (b *blockingRunner) Run(ctx context.Context, args []string, stdin string) ([]byte, error) {
	n := b.inFlight.Add(1)
	defer b.inFlight.Add(-1)
	for {
		m := b.maxSeen.Load()
		if n <= m || b.maxSeen.CompareAndSwap(m, n) {
			break
		}
	}
	b.started <- struct{}{}
	<-b.release
	return okEnvelope(`{"answer":"A","action":null}`), nil
}

func TestConcurrencyLimit(t *testing.T) {
	runner := &blockingRunner{started: make(chan struct{}, 3), release: make(chan struct{})}
	srv := newTestServer(t, runner, false)

	var wg sync.WaitGroup
	statuses := make(chan int, 3)
	for range 3 {
		wg.Go(func() {
			status, _ := post(t, srv, "category_question", `{}`)
			statuses <- status
		})
	}

	for range maxConcurrent {
		select {
		case <-runner.started:
		case <-time.After(5 * time.Second):
			t.Fatal("the first two calls did not start")
		}
	}
	select {
	case <-runner.started:
		t.Fatal("a third call started while two were running")
	case <-time.After(200 * time.Millisecond):
	}

	close(runner.release)
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Errorf("status = %d, want 200", status)
		}
	}
	if got := runner.maxSeen.Load(); got != maxConcurrent {
		t.Errorf("max concurrent calls = %d, want %d", got, maxConcurrent)
	}
}
