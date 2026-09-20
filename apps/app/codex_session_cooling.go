package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
)

type codexSessionCoolingError struct{ RetryAfterMs int64 }

func (e *codexSessionCoolingError) Error() string {
	return "当前会话的上游模型暂时繁忙，请稍后重试"
}

func parseCodexSessionCooling(status int, body []byte) error {
	var response struct {
		Code         string `json:"code"`
		RetryAfterMs int64  `json:"retryAfterMs"`
	}
	if status != 503 || json.Unmarshal(body, &response) != nil || response.Code != "codex_session_cooling" {
		return nil
	}
	if response.RetryAfterMs < 1000 {
		response.RetryAfterMs = 1000
	}
	if response.RetryAfterMs > 300000 {
		response.RetryAfterMs = 300000
	}
	return &codexSessionCoolingError{RetryAfterMs: response.RetryAfterMs}
}

func writeCodexSessionCooling(w http.ResponseWriter, err error) bool {
	var cooling *codexSessionCoolingError
	if !errors.As(err, &cooling) {
		return false
	}
	w.Header().Set("Retry-After", strconv.FormatInt((cooling.RetryAfterMs+999)/1000, 10))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": "codex_session_cooling", "message": cooling.Error(), "type": "server_error"}})
	return true
}
