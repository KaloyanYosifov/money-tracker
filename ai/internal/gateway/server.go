package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// maxConcurrent is the number of Claude runs at the same time. More requests
// wait for a free slot.
const maxConcurrent = 2

// maxBodyBytes limits the request body. 90 days of transactions fit well
// below it.
const maxBodyBytes = 8 << 20

type server struct {
	runner Runner
	fake   bool
	logger *slog.Logger
	sem    chan struct{}
}

// New returns the gateway routes. When fake is true, the tasks return their
// canned answers and the runner is not called.
func New(runner Runner, fake bool, logger *slog.Logger) http.Handler {
	s := &server{runner: runner, fake: fake, logger: logger, sem: make(chan struct{}, maxConcurrent)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /v1/tasks/{task}", s.handleTask)
	return mux
}

func (s *server) handleTask(w http.ResponseWriter, r *http.Request) {
	task, ok := tasks[r.PathValue("task")]
	if !ok {
		writeError(w, http.StatusNotFound, "unknown_task")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil || !json.Valid(body) {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	if s.fake {
		writeRaw(w, []byte(task.Fake))
		return
	}

	args, message, err := buildArgs(task, body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}

	select {
	case s.sem <- struct{}{}:
	case <-r.Context().Done():
		return
	}
	defer func() { <-s.sem }()

	ctx, cancel := context.WithTimeout(r.Context(), task.Timeout)
	defer cancel()
	start := time.Now()
	stdout, err := s.runner.Run(ctx, args, message)
	var out json.RawMessage
	if err == nil {
		out, err = parseOutput(stdout)
	}
	if err != nil {
		code := errorCode(err)
		s.logger.Error("task failed", "task", task.Name, "code", code, "duration_ms", time.Since(start).Milliseconds(), "err", err)
		writeError(w, http.StatusBadGateway, code)
		return
	}
	s.logger.Info("task done", "task", task.Name, "duration_ms", time.Since(start).Milliseconds())
	writeRaw(w, out)
}

// errorCode maps a run failure to the code in the JSON error body.
func errorCode(err error) string {
	switch {
	case errors.Is(err, ErrAuth):
		return "auth"
	case errors.Is(err, ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, ErrRateLimited):
		return "rate_limited"
	case errors.Is(err, ErrBadOutput):
		return "bad_output"
	default:
		return "failed"
	}
}

func writeRaw(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
