package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func pendingReportWithID(id, card string, addedAt time.Time) pendingReport {
	return pendingReport{
		Payload: map[string]interface{}{"reportId": id},
		Card:    card,
		AddedAt: addedAt,
	}
}

// A skipped expired report used to make the failure-path slice offset point at
// the failed item itself. Pending reports are user-namespaced and deliberately
// use the current renewed session credential, regardless of the stale Card field.
func TestFlushPendingReportsFailureRequeuesEachReportExactlyOnce(t *testing.T) {
	now := time.Now()
	var attemptsMu sync.Mutex
	var attempts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		attemptsMu.Lock()
		attempts = append(attempts, body["reportId"].(string))
		attemptsMu.Unlock()
		// Force a transport failure. postBcaiWithFallback intentionally treats
		// HTTP status codes as delivered responses, then retries transport errors
		// once through its fallback client.
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("test server does not support hijacking")
		}
		conn, _, err := hijacker.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		_ = conn.Close()
	}))
	defer srv.Close()
	oldBase := API_BASE
	API_BASE = srv.URL
	t.Cleanup(func() { API_BASE = oldBase })

	l := &Leaser{pendingReports: []pendingReport{
		pendingReportWithID("expired", "card-a", now.Add(-pendingReportMaxAge-time.Second)),
		pendingReportWithID("other-card", "card-b", now),
		pendingReportWithID("failed", "card-a", now),
		pendingReportWithID("untouched", "card-a", now),
	}}
	l.flushPendingReports("card-a", "")

	attemptsMu.Lock()
	gotAttempts := append([]string(nil), attempts...)
	attemptsMu.Unlock()
	if len(gotAttempts) != 2 || gotAttempts[0] != "other-card" || gotAttempts[1] != "other-card" {
		t.Fatalf("attempts = %v, want fallback attempts for first live report only", gotAttempts)
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	if len(l.pendingReports) != 3 {
		t.Fatalf("pending count = %d, want 3: %#v", len(l.pendingReports), l.pendingReports)
	}
	want := []string{"other-card", "failed", "untouched"}
	for i, report := range l.pendingReports {
		if got := report.Payload["reportId"]; got != want[i] {
			t.Fatalf("pending[%d] = %v, want %s (queue=%#v)", i, got, want[i], l.pendingReports)
		}
	}
}

func TestCodexAndClaudeFlushKeepOneCopyAfterExpiredPredecessor(t *testing.T) {
	for _, tc := range []struct {
		name    string
		setBase func(string)
		flush   func(pending []pendingReport) []pendingReport
	}{
		{
			name:    "codex",
			setBase: func(base string) { CODEX_API_BASE = base },
			flush: func(pending []pendingReport) []pendingReport {
				l := &CodexLeaser{pendingReports: pending}
				l.flushCodexPending("current-card", "")
				l.mu.Lock()
				defer l.mu.Unlock()
				return append([]pendingReport(nil), l.pendingReports...)
			},
		},
		{
			name:    "claude",
			setBase: func(base string) { ANTHROPIC_REMOTE_BASE = base },
			flush: func(pending []pendingReport) []pendingReport {
				l := &ClaudeLeaser{pendingReports: pending}
				l.flushClaudePending("current-card", "")
				l.mu.Lock()
				defer l.mu.Unlock()
				return append([]pendingReport(nil), l.pendingReports...)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var attempts atomic.Int64
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempts.Add(1)
				hijacker := w.(http.Hijacker)
				conn, _, err := hijacker.Hijack()
				if err != nil {
					t.Fatalf("hijack: %v", err)
				}
				_ = conn.Close()
			}))
			defer srv.Close()
			oldCodex, oldClaude := CODEX_API_BASE, ANTHROPIC_REMOTE_BASE
			tc.setBase(srv.URL)
			t.Cleanup(func() {
				CODEX_API_BASE, ANTHROPIC_REMOTE_BASE = oldCodex, oldClaude
			})

			now := time.Now()
			originalAddedAt := now.Add(-time.Minute)
			pending := tc.flush([]pendingReport{
				pendingReportWithID("expired", "old-card", now.Add(-pendingReportMaxAge-time.Second)),
				pendingReportWithID("failed", "old-card", originalAddedAt),
			})
			if got := attempts.Load(); got != 2 { // direct + transport fallback
				t.Fatalf("attempts = %d, want 2", got)
			}
			if len(pending) != 1 {
				t.Fatalf("pending count = %d, want exactly one failed report", len(pending))
			}
			if !pending[0].AddedAt.Equal(originalAddedAt) {
				t.Fatalf("retry renewed causal deadline: addedAt=%s want=%s", pending[0].AddedAt, originalAddedAt)
			}
		})
	}
}
