package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 三家(claude/codex/antigravity)的额度处理都走这套共享逻辑,这里集中覆盖。

func TestParseQuota429(t *testing.T) {
	body := []byte(`{"ok":false,"error":"Access key Anthropic · Claude token limit exceeded (130973/100000 tokens/5h)","retryAfterMs":17894536}`)
	rms, reason := parseQuota429(body)
	if rms != 17894536 {
		t.Fatalf("retryAfterMs = %d, want 17894536", rms)
	}
	if !strings.Contains(reason, "token limit exceeded") {
		t.Fatalf("reason = %q", reason)
	}
}

func TestIsHardQuotaLimit(t *testing.T) {
	// 大 retryAfter(claude/codex 的 429)→ 硬额度。
	if !isHardQuotaLimit(17_000_000, "") {
		t.Fatal("big retryAfter should be hard")
	}
	// 无 retryAfter 但文案是 token limit exceeded(antigravity success=false 场景)→ 硬额度。
	if !isHardQuotaLimit(0, "Access key X token limit exceeded (1/2 tokens/5h)") {
		t.Fatal("token-limit-exceeded text should be hard")
	}
	// 秒级临时公平限额(非硬额度)→ false。
	if isHardQuotaLimit(2000, "公平限额已用完 (已用 173K/160K 加权单元)") {
		t.Fatal("temp fair-share should NOT be hard")
	}
}

func TestQuotaExhaustedErrorMessageAndRetryAfter(t *testing.T) {
	qe := &QuotaExhaustedError{RetryAfterMs: 4*60*60*1000 + 35*60*1000, Reason: "X/Y tokens/5h"}
	if msg := qe.Error(); !strings.Contains(msg, "额度已用完") || !strings.Contains(msg, "4h35m") {
		t.Fatalf("Error() = %q (want 额度已用完 + 4h35m)", msg)
	}
	if s := qe.RetryAfterSeconds(); s != 4*3600+35*60 {
		t.Fatalf("RetryAfterSeconds = %d", s)
	}
	// 兜底:retryAfter 不足 1s 也至少给 1。
	if (&QuotaExhaustedError{}).RetryAfterSeconds() != 1 {
		t.Fatal("RetryAfterSeconds should floor at 1")
	}
}

func TestWriteQuotaExhausted(t *testing.T) {
	// QuotaExhaustedError → 写 429 + Retry-After,返回 true(IDE 据此退避,而非把 502 当临时故障狂试)。
	rec := httptest.NewRecorder()
	qe := &QuotaExhaustedError{RetryAfterMs: 5 * 60 * 60 * 1000, Reason: "token limit exceeded (130973/100000)"}
	if !writeQuotaExhausted(rec, qe) {
		t.Fatal("should handle QuotaExhaustedError")
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if ra := rec.Header().Get("Retry-After"); ra != "18000" {
		t.Fatalf("Retry-After = %q, want 18000", ra)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "rate_limit_error") {
		t.Fatalf("body should carry rate_limit_error: %s", rec.Body.String())
	}

	// 普通错误 → 不处理,返回 false(调用方走默认 502/503)。
	rec2 := httptest.NewRecorder()
	if writeQuotaExhausted(rec2, errors.New("network boom")) {
		t.Fatal("plain error should not be handled")
	}
	if rec2.Code != http.StatusOK { // 未写入 → recorder 默认 200
		t.Fatalf("plain error path should not write a status, got %d", rec2.Code)
	}
}
