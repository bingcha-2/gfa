package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func withCodexAPIBase(t *testing.T, base string) {
	t.Helper()
	old := CODEX_API_BASE
	CODEX_API_BASE = base
	t.Cleanup(func() { CODEX_API_BASE = old })
}

// codex 硬额度 429(token limit exceeded)→ 结构化 *QuotaExhaustedError,不重试、不挡路。
// 与 claude/antigravity 同一套行为(三家一致)。
func TestCodexHardLimitReturnsStructuredErrorAndDoesNotBlock(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":           false,
			"error":        "Access key Codex · GPT token limit exceeded (5200/1000 tokens/5h)",
			"retryAfterMs": 3 * 60 * 60 * 1000,
		})
	}))
	defer srv.Close()
	withCodexAPIBase(t, srv.URL)

	l := &CodexLeaser{}
	_, err := l.LeaseToken("card-1", "dev", true, nil, "")
	qe, ok := err.(*QuotaExhaustedError)
	if !ok {
		t.Fatalf("codex 硬额度应返回 *QuotaExhaustedError, got %T: %v", err, err)
	}
	if qe.RetryAfterMs != 3*60*60*1000 {
		t.Fatalf("RetryAfterMs = %d", qe.RetryAfterMs)
	}

	// 不挡路:再调一次仍真打上游(无熔断,允许用户/IDE 自己再试)。
	_, _ = l.LeaseToken("card-1", "dev", true, nil, "")
	if hits != 2 {
		t.Fatalf("codex must not block; want 2 upstream hits, got %d", hits)
	}
}
