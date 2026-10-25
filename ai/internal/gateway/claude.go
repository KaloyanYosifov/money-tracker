package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// The typed failures of a Claude run. The server maps each one to its JSON
// error code, and the API decides from the code whether to retry.
var (
	ErrAuth        = errors.New("claude: authentication failed")
	ErrTimeout     = errors.New("claude: timed out")
	ErrRateLimited = errors.New("claude: rate limited")
	ErrBadOutput   = errors.New("claude: output is not valid JSON")
)

// Runner runs one print-mode turn of the Claude CLI and returns its stdout.
type Runner interface {
	Run(ctx context.Context, args []string, stdin string) (stdout []byte, err error)
}

// CLIRunner runs the `claude` binary on PATH.
type CLIRunner struct{}

// Run starts `claude` with args and writes stdin to it. The user message goes
// on stdin, because 90 days of transactions can be larger than the argument
// limit.
func (CLIRunner) Run(ctx context.Context, args []string, stdin string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, ErrTimeout
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if err != nil {
		if typed := classify(stdout.String() + "\n" + stderr.String()); typed != nil {
			return nil, typed
		}
		return nil, fmt.Errorf("claude: %w: %s", err, truncate(strings.TrimSpace(stderr.String()), 200))
	}
	return stdout.Bytes(), nil
}

// classify finds an auth or rate-limit failure in the text of a failed run.
// It returns nil when the text names neither.
func classify(text string) error {
	t := strings.ToLower(text)
	for _, marker := range []string{"invalid api key", "/login", "oauth", "authentication", "unauthorized", "not logged in", "401"} {
		if strings.Contains(t, marker) {
			return ErrAuth
		}
	}
	for _, marker := range []string{"rate limit", "rate_limit", "usage limit", "429", "overloaded"} {
		if strings.Contains(t, marker) {
			return ErrRateLimited
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// envelope is the part of the `--output-format json` result that the gateway
// reads.
type envelope struct {
	Type             string          `json:"type"`
	Subtype          string          `json:"subtype"`
	IsError          bool            `json:"is_error"`
	Result           string          `json:"result"`
	StructuredOutput json.RawMessage `json:"structured_output"`
}

// parseOutput reads the result envelope from stdout and returns the JSON
// object that the model produced. Only structured_output is used, because the
// CLI checks it against the task's --json-schema and does not check result.
func parseOutput(stdout []byte) (json.RawMessage, error) {
	env, ok := findEnvelope(stdout)
	if !ok {
		return nil, ErrBadOutput
	}
	if env.IsError {
		if typed := classify(env.Result); typed != nil {
			return nil, typed
		}
		return nil, fmt.Errorf("claude: error result %q: %s", env.Subtype, truncate(env.Result, 200))
	}

	answer := bytes.TrimSpace(env.StructuredOutput)
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(answer, &obj); err != nil {
		return nil, ErrBadOutput
	}
	return answer, nil
}

// findEnvelope decodes the first JSON object in b that is the result
// envelope, and skips text before it.
func findEnvelope(b []byte) (envelope, bool) {
	for i := 0; i < len(b); i++ {
		if b[i] != '{' {
			continue
		}
		var env envelope
		if err := json.NewDecoder(bytes.NewReader(b[i:])).Decode(&env); err != nil {
			continue
		}
		if env.Type == "result" {
			return env, true
		}
	}
	return envelope{}, false
}
