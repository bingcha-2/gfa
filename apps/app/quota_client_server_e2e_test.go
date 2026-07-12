package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func quotaE2ESession(cardID string) string {
	encode := func(value any) string {
		raw, _ := json.Marshal(value)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	return encode(map[string]string{"alg": "HS256", "typ": "JWT"}) + "." +
		encode(map[string]string{"typ": "user-session", "sub": "quota-go-e2e", "cardId": cardID}) + ".sig"
}

func waitQuotaE2E(t *testing.T, label string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", label)
}

// TestQuotaClientServerE2E is run by tests/quota-e2e/run.mjs with a real Nest
// HTTP process. It deliberately uses the production CodexLeaser/ClaudeLeaser,
// quota parser, reporter, retry payload, and blood-bar consumers rather than a
// generic hand-built HTTP request helper.
func TestQuotaClientServerE2E(t *testing.T) {
	base := os.Getenv("BCAI_QUOTA_E2E_BASE")
	if base == "" {
		t.Skip("set BCAI_QUOTA_E2E_BASE from the cross-process orchestrator")
	}

	oldCodexBase, oldClaudeBase, oldUsageURL := CODEX_API_BASE, ANTHROPIC_REMOTE_BASE, CODEX_USAGE_URL
	CODEX_API_BASE = base + "/api/app/lease/codex"
	ANTHROPIC_REMOTE_BASE = base + "/api/app/lease/anthropic"
	t.Cleanup(func() {
		CODEX_API_BASE, ANTHROPIC_REMOTE_BASE, CODEX_USAGE_URL = oldCodexBase, oldClaudeBase, oldUsageURL
		resetBoundFractions()
	})
	resetBoundFractions()

	usedPercent := 0.0
	usageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		resetPrimary := time.Now().Add(5 * time.Hour).Unix()
		resetWeekly := time.Now().Add(7 * 24 * time.Hour).Unix()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"plan_type": "pro",
			"rate_limit": map[string]any{
				"primary_window":   map[string]any{"used_percent": usedPercent, "reset_at": resetPrimary},
				"secondary_window": map[string]any{"used_percent": usedPercent / 2, "reset_at": resetWeekly},
			},
		})
	}))
	defer usageServer.Close()
	CODEX_USAGE_URL = usageServer.URL

	codexCard := quotaE2ESession("card-101")
	codex := &CodexLeaser{}
	codexLease, err := codex.LeaseToken(codexCard, "go-e2e-codex", true, map[string]any{
		"modelKey": "gpt-5.6-sol",
	}, "")
	if err != nil {
		t.Fatalf("Codex LeaseToken: %v", err)
	}
	codex.RefreshQuotaUpstream(codexCard, "", codexLease, true)
	_ = codex.ConsumeCodexQuotaSnapshot() // baseline was already sent quota-only
	usedPercent = 20
	codex.RefreshQuotaUpstream(codexCard, "", codexLease, true)
	_ = codex.ConsumeCodexQuotaSnapshot() // force snapshot-before-usage ordering
	codex.ReportUsage(codexCard, "go-e2e-codex", ReportDetails{
		StatusCode: 200, ModelKey: "gpt-5.6-sol",
		InputTokens: 1_000_000, RawTotalTokens: 1_000_000, BillableTotalTokens: 1_000_000,
		RequestStartedAt:    time.Now().Add(-2 * time.Second).UnixMilli(),
		UpstreamCompletedAt: time.Now().Add(-time.Second).UnixMilli(),
		ServiceTier:         "priority", Surface: "desktop",
	}, "", codexLease)
	waitQuotaE2E(t, "Codex primary and weekly blood bars", func() bool {
		_, primary := snapshotMyFractions()["codex-gpt"]
		_, weekly := snapshotMyWeeklyFractions()["codex-gpt"]
		_, personalPrimary := snapshotMyPersonalFractions()["codex-gpt"]
		_, personalWeekly := snapshotMyPersonalWeeklyFractions()["codex-gpt"]
		return primary && weekly && personalPrimary && personalWeekly
	})

	claudeCard := quotaE2ESession("card-102")
	claude := &ClaudeLeaser{}
	claudeLease, err := claude.LeaseToken(claudeCard, "go-e2e-claude", true, map[string]any{
		"modelKey": "claude-opus-4-8",
	}, "")
	if err != nil {
		t.Fatalf("Claude LeaseToken: %v", err)
	}
	now := time.Now()
	baseline := ReportDetails{
		StatusCode: 0, ModelKey: "claude-opus-4-8", HasClaudeWindows: true,
		ClaudeHourlyPercent: 100, ClaudeWeeklyPercent: 100,
		ClaudeHourlyResetTime: now.Add(5 * time.Hour).Format(time.RFC3339),
		ClaudeWeeklyResetTime: now.Add(7 * 24 * time.Hour).Format(time.RFC3339),
		UpstreamCompletedAt:   now.UnixMilli(),
	}
	claude.ReportUsage(claudeCard, "go-e2e-claude", baseline, "", claudeLease)
	waitQuotaE2E(t, "Claude baseline", func() bool { return claude.LatestClaudeQuota() != nil })

	claude.ReportUsage(claudeCard, "go-e2e-claude", ReportDetails{
		StatusCode: 200, ModelKey: "claude-opus-4-8",
		InputTokens: 100, OutputTokens: 10, CachedInputTokens: 20,
		CacheWrite5mTokens: 50, CacheWrite1hTokens: 30,
		RawTotalTokens: 210, BillableTotalTokens: 192,
		RequestStartedAt:    now.Add(time.Second).UnixMilli(),
		UpstreamCompletedAt: now.Add(2 * time.Second).UnixMilli(),
		HasClaudeWindows:    true, ClaudeHourlyPercent: 85, ClaudeWeeklyPercent: 90,
		ClaudeHourlyResetTime: now.Add(5 * time.Hour).Format(time.RFC3339),
		ClaudeWeeklyResetTime: now.Add(7 * 24 * time.Hour).Format(time.RFC3339),
		Surface:               "cli", UserId: "go-e2e-user", SessionId: "go-e2e-session",
	}, "", claudeLease)
	waitQuotaE2E(t, "Claude primary and weekly blood bars", func() bool {
		_, primary := snapshotMyFractions()["anthropic-claude"]
		_, weekly := snapshotMyWeeklyFractions()["anthropic-claude"]
		_, personalPrimary := snapshotMyPersonalFractions()["anthropic-claude"]
		_, personalWeekly := snapshotMyPersonalWeeklyFractions()["anthropic-claude"]
		return primary && weekly && personalPrimary && personalWeekly
	})

	// Verify the Wails GetStats boundary that the React store consumes, not just
	// the internal Go parser maps.
	stats := (&App{}).GetStats()
	leaserStats, ok := stats["leaser"].(map[string]interface{})
	if !ok {
		t.Fatalf("GetStats leaser payload type = %T", stats["leaser"])
	}
	personalPrimary, ok := leaserStats["myPersonalFractions"].(map[string]float64)
	if !ok || personalPrimary["codex-gpt"] <= 0 || personalPrimary["anthropic-claude"] <= 0 {
		t.Fatalf("GetStats personal primary payload = %#v", leaserStats["myPersonalFractions"])
	}
	personalWeekly, ok := leaserStats["myPersonalWeeklyFractions"].(map[string]float64)
	if !ok || personalWeekly["codex-gpt"] <= 0 || personalWeekly["anthropic-claude"] <= 0 {
		t.Fatalf("GetStats personal weekly payload = %#v", leaserStats["myPersonalWeeklyFractions"])
	}

	// Exercise the actual client proxy path, not a direct stats helper: an
	// Anthropic response with distinct 5m/1h cache creation travels through
	// ClaudeProxy parsing, local dashboard pricing, and the live Nest reporter.
	previousStats := globalUsageStats
	globalUsageStats = &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	t.Cleanup(func() { globalUsageStats = previousStats })
	pricingUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Anthropic-Ratelimit-Unified-5h-Utilization", "0.25")
		w.Header().Set("Anthropic-Ratelimit-Unified-5h-Reset", fmt.Sprint(time.Now().Add(5*time.Hour).Unix()))
		w.Header().Set("Anthropic-Ratelimit-Unified-7d-Utilization", "0.20")
		w.Header().Set("Anthropic-Ratelimit-Unified-7d-Reset", fmt.Sprint(time.Now().Add(7*24*time.Hour).Unix()))
		_, _ = w.Write([]byte(`{"type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":200000,"cache_creation":{"ephemeral_5m_input_tokens":100000,"ephemeral_1h_input_tokens":100000},"cache_read_input_tokens":0}}`))
	}))
	defer pricingUpstream.Close()
	oldAnthropicAPIBase := ANTHROPIC_API_BASE
	ANTHROPIC_API_BASE = pricingUpstream.URL
	t.Cleanup(func() { ANTHROPIC_API_BASE = oldAnthropicAPIBase })
	proxyLease := *claudeLease
	proxyLease.ProxyURL = "http://quota-e2e-egress.invalid:8080"
	proxy := &ClaudeProxy{
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*ClaudeTokenLease, error) {
			return &proxyLease, nil
		},
		reportUsage: func(card, deviceID string, details ReportDetails, upstream string, lease *ClaudeTokenLease) {
			claude.ReportUsage(card, deviceID, details, upstream, lease)
		},
		upstreamClient: func(string) *http.Client { return pricingUpstream.Client() },
	}
	proxyRequest := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-opus-4-8","stream":false,"messages":[]}`))
	proxyResponse := httptest.NewRecorder()
	proxy.ServeHTTP(proxyResponse, proxyRequest, claudeCard, "go-e2e-proxy", "")
	if proxyResponse.Code != http.StatusOK {
		t.Fatalf("ClaudeProxy pricing request status=%d body=%s", proxyResponse.Code, proxyResponse.Body.String())
	}
	pricingRow := globalUsageStats.GetTodayRecord().ByModel["claude-opus-4-8"]
	if pricingRow == nil || pricingRow.CacheWriteTokens != 200_000 {
		t.Fatalf("ClaudeProxy dashboard row = %+v, want 200K cache writes", pricingRow)
	}
	if want := 1.625; pricingRow.EstimatedCostUSD < want-1e-9 || pricingRow.EstimatedCostUSD > want+1e-9 {
		t.Fatalf("ClaudeProxy dashboard cost=%v, want %v from 5m/1h split", pricingRow.EstimatedCostUSD, want)
	}
	waitQuotaE2E(t, "ClaudeProxy report round-trip", func() bool {
		quota := claude.LatestClaudeQuota()
		return quota != nil && quota.HourlyPercent == 75 && quota.WeeklyPercent == 80
	})

	for bucket, fraction := range snapshotMyFractions() {
		if fraction < 0 || fraction > 1 {
			t.Fatalf("invalid primary fraction %s=%v", bucket, fraction)
		}
	}
	for bucket, fraction := range snapshotMyWeeklyFractions() {
		if fraction < 0 || fraction > 1 {
			t.Fatalf("invalid weekly fraction %s=%v", bucket, fraction)
		}
	}
	if got := snapshotMyWeeklyResetAts()["anthropic-claude"]; got <= now.UnixMilli() {
		t.Fatalf("Claude weekly resetAt was not consumed: %d", got)
	}
	if got := snapshotMyWeeklyResetAts()["codex-gpt"]; got <= now.UnixMilli() {
		t.Fatalf("Codex weekly resetAt was not consumed: %d", got)
	}

	// 会话切换清理(放在全部血条断言之后):登出/换号路径调用的 clearLocalCardState
	// 必须把 GetStats 暴露给前端的个人血条一并清空,下一账号不能看到上一账号的
	// 独享余量。
	clearLocalCardState()
	clearedStats := (&App{}).GetStats()
	clearedLeaser := clearedStats["leaser"].(map[string]interface{})
	if cleared, _ := clearedLeaser["myPersonalFractions"].(map[string]float64); len(cleared) != 0 {
		t.Fatalf("personal fractions survived clearLocalCardState: %#v", cleared)
	}
	if cleared, _ := clearedLeaser["myPersonalWeeklyFractions"].(map[string]float64); len(cleared) != 0 {
		t.Fatalf("personal weekly fractions survived clearLocalCardState: %#v", cleared)
	}
	t.Logf("production leasers completed against %s (%s, %s)", base, fmt.Sprint(codexLease.AccountId), fmt.Sprint(claudeLease.AccountId))
}

// TestQuotaPendingQueueE2E drives the production retry queue through a real
// HTTP transport failure and recovery. The old offset bug duplicated the failed
// item when an expired and another-card item preceded it.
func TestQuotaPendingQueueE2E(t *testing.T) {
	now := time.Now()
	var failing atomic.Bool
	failing.Store(true)
	var mu sync.Mutex
	accepted := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if failing.Load() {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("hijack failed transport: %v", err)
				return
			}
			_ = connection.Close()
			return
		}
		mu.Lock()
		accepted = append(accepted, fmt.Sprint(payload["reportId"]))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	oldBase := API_BASE
	API_BASE = server.URL
	t.Cleanup(func() { API_BASE = oldBase })

	leaser := &Leaser{pendingReports: []pendingReport{
		pendingReportWithID("expired", "card-a", now.Add(-pendingReportMaxAge-time.Second)),
		pendingReportWithID("other-card", "card-b", now),
		pendingReportWithID("failed", "card-a", now),
		pendingReportWithID("untouched", "card-a", now),
	}}
	leaser.flushPendingReports("card-a", "")
	leaser.mu.RLock()
	queued := append([]pendingReport(nil), leaser.pendingReports...)
	leaser.mu.RUnlock()
	wantQueued := []string{"other-card", "failed", "untouched"}
	if len(queued) != len(wantQueued) {
		t.Fatalf("queue after failure=%#v, want %v", queued, wantQueued)
	}
	for index, report := range queued {
		if got := fmt.Sprint(report.Payload["reportId"]); got != wantQueued[index] {
			t.Fatalf("queue[%d]=%s, want %s", index, got, wantQueued[index])
		}
	}

	failing.Store(false)
	leaser.flushPendingReports("card-a", "")
	leaser.flushPendingReports("card-b", "")
	if leaser.pendingCount() != 0 {
		t.Fatalf("queue not empty after recovery: %#v", leaser.pendingReports)
	}
	mu.Lock()
	gotAccepted := append([]string(nil), accepted...)
	mu.Unlock()
	wantAccepted := []string{"failed", "untouched", "other-card"}
	if len(gotAccepted) != len(wantAccepted) {
		t.Fatalf("accepted reports=%v, want %v", gotAccepted, wantAccepted)
	}
	for index := range wantAccepted {
		if gotAccepted[index] != wantAccepted[index] {
			t.Fatalf("accepted reports=%v, want %v", gotAccepted, wantAccepted)
		}
	}
}
