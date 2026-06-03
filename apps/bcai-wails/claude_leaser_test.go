package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// withClaudeAPIBase points CLAUDE_API_BASE at a test server for the duration of fn.
func withClaudeAPIBase(t *testing.T, base string) {
	t.Helper()
	prev := CLAUDE_API_BASE
	CLAUDE_API_BASE = base
	t.Cleanup(func() { CLAUDE_API_BASE = prev })
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
