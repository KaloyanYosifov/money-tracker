package gateway

import (
	"errors"
	"testing"
)

func TestRunFailure(t *testing.T) {
	tests := []struct {
		name   string
		stdout string
		stderr string
		want   error
	}{
		{"token count with 401", `{"type":"result","is_error":true,"result":"model error","usage":{"cache_read_input_tokens":14012}}`, "", nil},
		{"token count with 429", `{"type":"result","is_error":true,"result":"model error","duration_ms":4291}`, "", nil},
		{"auth in result", `{"type":"result","is_error":true,"result":"API Error: 401 invalid token"}`, "", ErrAuth},
		{"auth in stderr", "", "Not logged in. Please run /login", ErrAuth},
		{"rate limit in result", `{"type":"result","is_error":true,"result":"API Error: 429"}`, "", ErrRateLimited},
		{"no envelope", "status 401", "", ErrAuth},
		{"other failure", "", "exit status 1", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := runFailure([]byte(tt.stdout), []byte(tt.stderr)); !errors.Is(got, tt.want) && got != tt.want {
				t.Errorf("runFailure = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseOutputRejectsNullStructuredOutput(t *testing.T) {
	if _, err := parseOutput([]byte(`{"type":"result","is_error":false,"structured_output":null}`)); !errors.Is(err, ErrBadOutput) {
		t.Errorf("parseOutput = %v, want ErrBadOutput", err)
	}
}
