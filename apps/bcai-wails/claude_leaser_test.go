package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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

func TestClaudeLease429TripsBreakerAndRecovers(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	quotaExhausted := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		hits++
		if quotaExhausted {
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": false, "error": "公平限额已用完 (已用 173K/160K 加权单元)",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true, "accessToken": "sk-ant-ok", "accountId": 1, "leaseId": "l1",
		})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)
	hitCount := func() int { mu.Lock(); defer mu.Unlock(); return hits }

	now := time.Unix(1_700_000_000, 0)
	l := &ClaudeLeaser{nowFn: func() time.Time { return now }}

	// 1) 首次:打到上游,拿 429,开闸熔断。
	if _, err := l.LeaseToken("card-1", "dev", true, nil, ""); err == nil {
		t.Fatal("want 429 error on first call")
	}
	if got := hitCount(); got != 1 {
		t.Fatalf("first call should hit upstream once, got %d", got)
	}

	// 2) 冷却期内:本地快速失败,绝不打上游。
	if _, err := l.LeaseToken("card-1", "dev", true, nil, ""); err == nil {
		t.Fatal("want fast-fail during cooldown")
	}
	if got := hitCount(); got != 1 {
		t.Fatalf("cooldown call must NOT hit upstream, hits=%d", got)
	}

	// 3) 另一张卡不受牵连:照常请求上游(同样 429)。
	if _, err := l.LeaseToken("card-2", "dev", true, nil, ""); err == nil {
		t.Fatal("want 429 for card-2")
	}
	if got := hitCount(); got != 2 {
		t.Fatalf("card-2 should hit upstream independently, hits=%d", got)
	}

	// 4) 时间过了冷却期 + 上游恢复 → 放行成功,并重置该卡熔断。
	now = now.Add(claudeBreakerBase + time.Second)
	mu.Lock()
	quotaExhausted = false
	mu.Unlock()
	lease, err := l.LeaseToken("card-1", "dev", true, nil, "")
	if err != nil {
		t.Fatalf("after cooldown+recovery want success, got %v", err)
	}
	if lease.AccessToken != "sk-ant-ok" {
		t.Fatalf("unexpected lease %+v", lease)
	}
	if got := hitCount(); got != 3 {
		t.Fatalf("post-cooldown call should hit upstream, hits=%d", got)
	}
	if _, open := l.breakerRetryAfter("card-1"); open {
		t.Fatal("breaker should be reset after a successful lease")
	}
}

func TestClaudeLeaseBreakerBackoffGrows(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "公平限额已用完"})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)

	now := time.Unix(1_700_000_000, 0)
	l := &ClaudeLeaser{nowFn: func() time.Time { return now }}

	// 连续命中 429,每次冷却时长应翻倍(base, 2·base, 4·base …),且不超过封顶。
	var prev time.Duration
	for i := 0; i < 4; i++ {
		if _, err := l.LeaseToken("card-1", "dev", true, nil, ""); err == nil {
			t.Fatalf("attempt %d: want 429 error", i)
		}
		wait, open := l.breakerRetryAfter("card-1")
		if !open {
			t.Fatalf("attempt %d: breaker should be open", i)
		}
		if i > 0 && wait <= prev && prev < claudeBreakerMax {
			t.Fatalf("attempt %d: backoff did not grow (prev=%v now=%v)", i, prev, wait)
		}
		if wait > claudeBreakerMax {
			t.Fatalf("attempt %d: backoff %v exceeds cap %v", i, wait, claudeBreakerMax)
		}
		prev = wait
		// 推进到刚好越过本次冷却,让下一次再次打到上游并续期退避。
		now = now.Add(wait + time.Millisecond)
	}
}

func TestClaudeActivateSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/activate" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"data":    map[string]interface{}{"accountCard": map[string]interface{}{"expiresAt": "2026-12-31T00:00:00Z"}},
		})
	}))
	defer srv.Close()
	withClaudeAPIBase(t, srv.URL)

	l := &ClaudeLeaser{}
	exp, err := l.Activate("card-1", "dev-1", "")
	if err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if exp != "2026-12-31T00:00:00Z" {
		t.Fatalf("unexpected expiry %q", exp)
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
