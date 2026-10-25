package aiclient_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/KaloyanYosifov/money-tracker/api/internal/aiclient"
)

type input struct {
	Today string `json:"today"`
}

// gateway starts a fake gateway that answers every request with status and
// body, and records the last request.
func gateway(t *testing.T, status int, body string) (*aiclient.Client, *http.Request, *[]byte) {
	t.Helper()
	var got http.Request
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = *r
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return aiclient.New(srv.URL, srv.Client()), &got, &gotBody
}

func TestDailyInsightsReturnsParsedResult(t *testing.T) {
	c, req, body := gateway(t, http.StatusOK,
		`{"cards":[{"kind":"budget","title":"T","body":"B","fingerprint":"fp","action":{"category_id":"c1","amount_minor":500}}],"summary":"S"}`)

	res, err := c.DailyInsights(context.Background(), input{Today: "2026-10-24"})
	if err != nil {
		t.Fatalf("DailyInsights: %v", err)
	}
	if req.Method != http.MethodPost || req.URL.Path != "/v1/tasks/daily_insights" {
		t.Fatalf("request = %s %s", req.Method, req.URL.Path)
	}
	if ct := req.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if string(*body) != `{"today":"2026-10-24"}` {
		t.Fatalf("body = %s", *body)
	}
	if res.Summary != "S" || len(res.Cards) != 1 {
		t.Fatalf("result = %+v", res)
	}
	card := res.Cards[0]
	if card.Kind != "budget" || card.Title != "T" || card.Body != "B" || card.Fingerprint != "fp" {
		t.Fatalf("card = %+v", card)
	}
	if string(card.Action) != `{"category_id":"c1","amount_minor":500}` {
		t.Fatalf("action = %s", card.Action)
	}
}

func TestCategoryQuestionReturnsParsedResult(t *testing.T) {
	c, req, body := gateway(t, http.StatusOK, `{"answer":"Spend less.","action":null}`)

	res, err := c.CategoryQuestion(context.Background(), input{Today: "2026-10-24"})
	if err != nil {
		t.Fatalf("CategoryQuestion: %v", err)
	}
	if req.Method != http.MethodPost || req.URL.Path != "/v1/tasks/category_question" {
		t.Fatalf("request = %s %s", req.Method, req.URL.Path)
	}
	if string(*body) != `{"today":"2026-10-24"}` {
		t.Fatalf("body = %s", *body)
	}
	if res.Answer != "Spend less." {
		t.Fatalf("answer = %q", res.Answer)
	}
	if res.Action != nil && string(res.Action) != "null" {
		t.Fatalf("action = %s", res.Action)
	}
}

func TestGatewayErrorsAreTyped(t *testing.T) {
	cases := map[string]error{
		"auth":         aiclient.ErrAuth,
		"timeout":      aiclient.ErrTimeout,
		"rate_limited": aiclient.ErrRateLimited,
		"bad_output":   aiclient.ErrBadOutput,
	}
	for code, want := range cases {
		t.Run(code, func(t *testing.T) {
			c, _, _ := gateway(t, http.StatusBadGateway, `{"error":"`+code+`"}`)
			if _, err := c.DailyInsights(context.Background(), input{}); !errors.Is(err, want) {
				t.Fatalf("DailyInsights err = %v, want %v", err, want)
			}
			if _, err := c.CategoryQuestion(context.Background(), input{}); !errors.Is(err, want) {
				t.Fatalf("CategoryQuestion err = %v, want %v", err, want)
			}
		})
	}
}

func TestOtherFailuresAreGeneric(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"not found", http.StatusNotFound, `{"error":"unknown_task"}`},
		{"failed", http.StatusBadGateway, `{"error":"failed"}`},
		{"no json body", http.StatusInternalServerError, `oops`},
		{"bad 200 body", http.StatusOK, `not json`},
	}
	typed := []error{aiclient.ErrAuth, aiclient.ErrTimeout, aiclient.ErrRateLimited, aiclient.ErrBadOutput}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _, _ := gateway(t, tc.status, tc.body)
			_, err := c.DailyInsights(context.Background(), input{})
			if err == nil {
				t.Fatal("err = nil")
			}
			for _, e := range typed {
				if errors.Is(err, e) {
					t.Fatalf("err = %v, want a generic error", err)
				}
			}
		})
	}
}

// stalledGateway starts a gateway that answers no request until the test
// ends.
func stalledGateway(t *testing.T) *aiclient.Client {
	t.Helper()
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	return aiclient.New(srv.URL, srv.Client())
}

func TestRequestHasTimeout(t *testing.T) {
	c := stalledGateway(t)
	c.Timeout = 50 * time.Millisecond
	start := time.Now()
	_, err := c.CategoryQuestion(context.Background(), input{})
	if !errors.Is(err, aiclient.ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("the request took %s, the timeout did not apply", time.Since(start))
	}
}

func TestCallerCancelIsNotATimeout(t *testing.T) {
	c := stalledGateway(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	_, err := c.DailyInsights(ctx, input{})
	if !errors.Is(err, context.Canceled) || errors.Is(err, aiclient.ErrTimeout) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestInputThatDoesNotEncodeFails(t *testing.T) {
	c, _, _ := gateway(t, http.StatusOK, `{}`)
	if _, err := c.DailyInsights(context.Background(), make(chan int)); err == nil {
		t.Fatal("err = nil")
	}
}
