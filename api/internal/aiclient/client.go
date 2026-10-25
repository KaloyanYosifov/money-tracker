// Package aiclient calls the AI gateway (money-tracker-ai) over HTTP.
//
// The package does not import internal/insights, because insights uses the
// typed errors of this package. Card has the same fields as insights.Card, so
// a caller converts it with insights.Card(card).
package aiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultTimeout is the time limit of one call. The gateway gives Claude 90s
// and can queue a request behind two runs.
const DefaultTimeout = 5 * time.Minute

// The gateway failures that a caller handles. Other failures are generic
// errors.
var (
	ErrAuth        = errors.New("ai gateway: auth failed")
	ErrTimeout     = errors.New("ai gateway: timeout")
	ErrRateLimited = errors.New("ai gateway: rate limited")
	ErrBadOutput   = errors.New("ai gateway: bad output")
)

var errorCodes = map[string]error{
	"auth":         ErrAuth,
	"timeout":      ErrTimeout,
	"rate_limited": ErrRateLimited,
	"bad_output":   ErrBadOutput,
}

// Card is one card of the daily_insights task. Action is the raw JSON action
// or null; insights.CheckCard checks it.
type Card struct {
	Kind        string          `json:"kind"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	Fingerprint string          `json:"fingerprint"`
	Action      json.RawMessage `json:"action,omitempty"`
}

// DailyInsightsResult is the output of the daily_insights task.
type DailyInsightsResult struct {
	Cards   []Card `json:"cards"`
	Summary string `json:"summary"`
}

// CategoryQuestionResult is the output of the category_question task. Action
// is the raw JSON action or null; insights.CheckAnswerAction checks it.
type CategoryQuestionResult struct {
	Answer string          `json:"answer"`
	Action json.RawMessage `json:"action,omitempty"`
}

// Client calls the gateway. Timeout limits each call; New sets it to
// DefaultTimeout.
type Client struct {
	baseURL string
	http    *http.Client
	Timeout time.Duration
}

// New returns a client for the gateway at baseURL. A nil httpClient uses
// http.DefaultClient.
func New(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: httpClient, Timeout: DefaultTimeout}
}

// DailyInsights runs the daily_insights task. input is sent as the JSON body.
func (c *Client) DailyInsights(ctx context.Context, input any) (DailyInsightsResult, error) {
	var out DailyInsightsResult
	err := c.call(ctx, "daily_insights", input, &out)
	return out, err
}

// CategoryQuestion runs the category_question task. input is sent as the
// JSON body.
func (c *Client) CategoryQuestion(ctx context.Context, input any) (CategoryQuestionResult, error) {
	var out CategoryQuestionResult
	err := c.call(ctx, "category_question", input, &out)
	return out, err
}

func (c *Client) call(ctx context.Context, task string, input, out any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("ai gateway %s: encode input: %w", task, err)
	}

	callCtx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, c.baseURL+"/v1/tasks/"+task, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("ai gateway %s: %w", task, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// Our own time limit is a timeout; a cancel by the caller is not.
		if ctx.Err() == nil && errors.Is(callCtx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("ai gateway %s: %w", task, ErrTimeout)
		}
		return fmt.Errorf("ai gateway %s: %w", task, err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("ai gateway %s: read response: %w", task, err)
	}

	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(respBody, &e)
		if typed, ok := errorCodes[e.Error]; ok {
			return fmt.Errorf("ai gateway %s: %w", task, typed)
		}
		return fmt.Errorf("ai gateway %s: status %d, error %q", task, resp.StatusCode, e.Error)
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("ai gateway %s: decode response: %w", task, err)
	}
	return nil
}
