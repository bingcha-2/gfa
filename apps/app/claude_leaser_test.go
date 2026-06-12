package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// withClaudeAPIBase points ANTHROPIC_REMOTE_BASE at a test server for the duration of fn.
func withClaudeAPIBase(t *testing.T, base string) {
	t.Helper()
	prev := ANTHROPIC_REMOTE_BASE
	ANTHROPIC_REMOTE_BASE = base
	t.Cleanup(func() { ANTHROPIC_REMOTE_BASE = prev })
}

func TestClaudeLeaseTokenSuccessAppliesWindows(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/lease-token" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":          true,
			"accessToken": "sk-ant-leased",
			"accountId":   21,
			"leaseId":     "lease-1",
			"emailHint":   "ma***@x.com",
			"claudeWindows": map[string]interface{}{
				"hourlyPercent": 80,
				"weeklyPercent": 30,
			},
		})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)

	l := &ClaudeLeaser{}
	lease, err := l.LeaseToken("card-1", "dev-1", true, map[string]interface{}{"modelKey": "claude-opus-4-20250514"}, "")
	if err != nil {
		t.Fatalf("LeaseToken: %v", err)
	}
	if lease.AccessToken != "sk-ant-leased" || lease.AccountId != 21 || lease.LeaseId != "lease-1" {
		t.Fatalf("unexpected lease: %+v", lease)
	}
	q := l.LatestClaudeQuota()
	if q == nil || q.HourlyPercent != 80 || q.WeeklyPercent != 30 {
		t.Fatalf("claude windows not applied: %+v", q)
	}
}

func TestClaudeLeaseTokenErrorSurfacesMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":      false,
			"message": "No available Claude accounts",
		})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)

	l := &ClaudeLeaser{}
	_, err := l.LeaseToken("card-1", "dev-1", false, nil, "")
	if err == nil || err.Error() != "No available Claude accounts" {
		t.Fatalf("want error 'No available Claude accounts', got %v", err)
	}
	if l.LastError() != "No available Claude accounts" {
		t.Fatalf("LastError not set: %q", l.LastError())
	}
}

// 全拆熔断后:硬额度 429(token limit exceeded,retryAfter 达数小时)→ 返回结构化
// *QuotaExhaustedError(供 proxy 转 429+Retry-After),lastError 带「额度已用完」(→ block
// 红 banner),且【不挡路】——再调一次仍真打上游,允许用户/IDE 自己再试。
func TestClaudeHardLimitReturnsStructuredErrorAndDoesNotBlock(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":           false,
			"error":        "Access key Anthropic · Claude token limit exceeded (130973/100000 tokens/5h)",
			"retryAfterMs": 5 * 60 * 60 * 1000, // 5h
		})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)
	hitCount := func() int { mu.Lock(); defer mu.Unlock(); return hits }

	l := &ClaudeLeaser{nowFn: func() time.Time { return time.Unix(1_700_000_000, 0) }}

	_, err := l.LeaseToken("card-1", "dev", true, nil, "")
	qe, ok := err.(*QuotaExhaustedError)
	if !ok {
		t.Fatalf("硬额度应返回 *QuotaExhaustedError, got %T: %v", err, err)
	}
	if qe.RetryAfterMs != 5*60*60*1000 {
		t.Fatalf("RetryAfterMs = %d, want 5h", qe.RetryAfterMs)
	}
	if !strings.Contains(l.LastError(), "额度已用完") {
		t.Fatalf("lastError 应含「额度已用完」, got %q", l.LastError())
	}
	if got := hitCount(); got != 1 {
		t.Fatalf("first call should hit upstream once, got %d", got)
	}

	// 关键:不挡路。再调一次仍真打上游(熔断已拆)。
	_, _ = l.LeaseToken("card-1", "dev", true, nil, "")
	if got := hitCount(); got != 2 {
		t.Fatalf("second call should ALSO hit upstream (no breaker), got %d", got)
	}
}

// 临时公平限额(无 retryAfter / 秒级)→ 返回普通 error(非 QuotaExhaustedError),同样不挡路。
func TestClaudeTempLimitReturnsPlainErrorAndDoesNotBlock(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false, "error": "公平限额已用完 (已用 173K/160K 加权单元)",
		})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)
	hitCount := func() int { mu.Lock(); defer mu.Unlock(); return hits }

	l := &ClaudeLeaser{nowFn: func() time.Time { return time.Unix(1_700_000_000, 0) }}

	_, err := l.LeaseToken("card-1", "dev", true, nil, "")
	if err == nil {
		t.Fatal("want error on 429")
	}
	if _, ok := err.(*QuotaExhaustedError); ok {
		t.Fatalf("临时限额不应是 QuotaExhaustedError: %v", err)
	}
	// 不挡路:再调仍真打上游。
	_, _ = l.LeaseToken("card-1", "dev", true, nil, "")
	if got := hitCount(); got != 2 {
		t.Fatalf("temp-limit must not block; second call should hit upstream, got %d", got)
	}
}

func TestClaudeReportRetryQueuesThenFlushes(t *testing.T) {
	var mu sync.Mutex
	fail := true
	received := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		mu.Lock()
		defer mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		received++
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)

	l := &ClaudeLeaser{}
	// A failing report goes straight to the pending queue (no successful flush).
	l.queueClaudeReport(map[string]interface{}{"leaseId": "lease-1", "totalTokens": 10}, "card-1", "")
	if got := l.pendingCount(); got != 1 {
		t.Fatalf("expected 1 pending report, got %d", got)
	}

	// Server recovers → flush drains the queue.
	mu.Lock()
	fail = false
	mu.Unlock()
	l.flushClaudePending("card-1", "")
	if got := l.pendingCount(); got != 0 {
		t.Fatalf("queue not drained after flush, %d pending", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if received != 1 {
		t.Fatalf("server should have received 1 flushed report, got %d", received)
	}
}

// 服务端把账号绑定的出口代理 + 出口策略随 lease 下发(accountProxyUrl/egressRequired),
// 客户端必须解析进 lease.EgressInfo —— anthropic 恒为 required(fail-closed)。
func TestClaudeLeaseTokenParsesEgressInfo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":              true,
			"accessToken":     "sk-ant-leased",
			"accountId":       7,
			"leaseId":         "lease-1",
			"accountProxyUrl": "socks5://u:p@res.example:1080",
			"egressRequired":  true,
		})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)

	l := &ClaudeLeaser{}
	lease, err := l.LeaseToken("card-1", "dev-1", true, nil, "")
	if err != nil {
		t.Fatalf("LeaseToken: %v", err)
	}
	if lease.ProxyURL != "socks5://u:p@res.example:1080" {
		t.Fatalf("lease.ProxyURL = %q, want the bound residential proxy", lease.ProxyURL)
	}
	if !lease.EgressRequired {
		t.Fatalf("anthropic lease must carry EgressRequired=true (fail-closed)")
	}
}
