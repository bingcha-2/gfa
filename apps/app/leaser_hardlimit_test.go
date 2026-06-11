package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// antigravity 硬额度走 success=false(无 HTTP 429),靠文案「token limit exceeded」识别 →
// 结构化 *QuotaExhaustedError(proxy 据此转 429 + Retry-After),不卷入 maxLeaseRetries 网络
// 重试。与 claude/codex 同一套行为(三家一致)。
func TestAntigravityHardLimitReturnsStructuredError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Access key Antigravity · Gemini token limit exceeded (12000/10000 tokens/5h)",
		})
	}))
	defer srv.Close()
	oldBase := API_BASE
	API_BASE = srv.URL
	t.Cleanup(func() { API_BASE = oldBase })

	l := &Leaser{}
	_, err := l.LeaseToken("card-1", "dev", true, map[string]interface{}{"modelKey": "gemini-2.5-pro"}, "")
	if _, ok := err.(*QuotaExhaustedError); !ok {
		t.Fatalf("antigravity 硬额度应返回 *QuotaExhaustedError, got %T: %v", err, err)
	}
}
