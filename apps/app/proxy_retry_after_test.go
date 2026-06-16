package main

import (
	"net/http"
	"testing"
	"time"
)

// parseRetryAfterHeaderMs 解析上游 429 的 HTTP Retry-After 头(秒数 / HTTP-date)。
// Anthropic rate_limit_error 把恢复时间放这头里(body 里没有),是短冷却的关键来源。
func TestParseRetryAfterHeaderMs(t *testing.T) {
	if got := parseRetryAfterHeaderMs("60"); got != 60_000 {
		t.Fatalf("秒数: want 60000, got %d", got)
	}
	if got := parseRetryAfterHeaderMs("  30 "); got != 30_000 {
		t.Fatalf("带空白秒数: want 30000, got %d", got)
	}
	if got := parseRetryAfterHeaderMs(""); got != 0 {
		t.Fatalf("空: want 0, got %d", got)
	}
	if got := parseRetryAfterHeaderMs("0"); got != 0 {
		t.Fatalf("0 秒: want 0, got %d", got)
	}
	if got := parseRetryAfterHeaderMs("-5"); got != 0 {
		t.Fatalf("负数: want 0, got %d", got)
	}
	if got := parseRetryAfterHeaderMs("not-a-number"); got != 0 {
		t.Fatalf("垃圾值: want 0, got %d", got)
	}

	// HTTP-date:取未来 ~2h 的时间点,应解析出正数毫秒。
	future := time.Now().Add(2 * time.Hour).UTC().Format(http.TimeFormat)
	if got := parseRetryAfterHeaderMs(future); got <= 0 {
		t.Fatalf("HTTP-date(未来): want >0, got %d", got)
	}
	// 过去的 HTTP-date → 已可重试 → 0。
	past := time.Now().Add(-2 * time.Hour).UTC().Format(http.TimeFormat)
	if got := parseRetryAfterHeaderMs(past); got != 0 {
		t.Fatalf("HTTP-date(过去): want 0, got %d", got)
	}
}
