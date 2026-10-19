package sync

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/schema"
)

type rejection struct {
	Index   int    `json:"index"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// NewUploadHandler serves POST /api/sync/upload. Wrap it in
// auth.Handlers.RequireUser, because it reads the user from auth.UserID.
// The whole batch runs in one transaction. A rejected op does not stop the
// batch. A server fault rolls back the batch and gives 503, so that the
// client sends the whole batch again.
func NewUploadHandler(pool *pgxpool.Pool, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := auth.UserID(r.Context())
		if userID == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		ops, status, code := decodeUpload(r.Body)
		if status != 0 {
			writeError(w, status, code)
			return
		}

		ctx := r.Context()
		tx, err := pool.Begin(ctx)
		if err != nil {
			logger.Error("upload: begin", "user_id", userID, "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()

		rejected := []rejection{}
		var applied, ignored int
		for i, op := range ops {
			res, err := ApplyOp(ctx, tx, userID, op)
			if err != nil {
				logger.Error("upload: apply", "user_id", userID, "index", i, "err", err)
				writeError(w, http.StatusServiceUnavailable, "unavailable")
				return
			}
			switch res.Status {
			case Applied:
				applied++
			case Ignored:
				ignored++
			case Rejected:
				rejected = append(rejected, rejection{Index: i, Code: res.Code, Message: res.Message})
			}
		}
		if err := tx.Commit(ctx); err != nil {
			logger.Error("upload: commit", "user_id", userID, "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		logger.Info("upload",
			"user_id", userID,
			"ops", len(ops),
			"applied", applied,
			"ignored", ignored,
			"rejected", len(rejected),
		)
		writeJSON(w, http.StatusOK, map[string]any{"rejected": rejected})
	})
}

// decodeUpload reads and checks the body. A status other than 0 is the
// error answer. Numbers stay json.Number, so that large integers keep
// their exact value.
func decodeUpload(body io.Reader) ([]schema.UploadOp, int, string) {
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, http.StatusBadRequest, "invalid_request"
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil || dec.More() {
		return nil, http.StatusBadRequest, "invalid_request"
	}

	// The version check comes before the schema check, because an old
	// client can send a body that the current schema does not accept.
	obj, _ := doc.(map[string]any)
	if n, ok := obj["schema_version"].(json.Number); ok {
		if v, err := n.Int64(); err == nil && v < schema.MinSupportedSchemaVersion {
			return nil, http.StatusUpgradeRequired, "upgrade_required"
		}
	}

	v, err := validator()
	if err != nil {
		return nil, http.StatusServiceUnavailable, "unavailable"
	}
	if err := v.ValidateUpload(doc); err != nil {
		return nil, http.StatusBadRequest, "invalid_request"
	}

	items := obj["ops"].([]any)
	ops := make([]schema.UploadOp, len(items))
	for i, item := range items {
		m := item.(map[string]any)
		ops[i] = schema.UploadOp{
			Op:    schema.UploadOpOp(m["op"].(string)),
			Table: schema.UploadOpTable(m["table"].(string)),
			ID:    m["id"].(string),
		}
		if d, ok := m["data"].(map[string]any); ok {
			ops[i].Data = d
		}
	}
	return ops, 0, ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
