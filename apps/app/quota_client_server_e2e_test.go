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
// quota parser, reporter, retry payload, and product-dollar consumers rather than a
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

	usedPercent := 100.0
	weeklyOnly := false
	emptyUsage := false
	usageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if emptyUsage {
			_ = json.NewEncoder(w).Encode(map[string]any{"plan_type": "pro", "rate_limit": map[string]any{}})
			return
		}
		resetPrimary := time.Now().Add(5 * time.Hour).Unix()
		resetWeekly := time.Now().Add(7 * 24 * time.Hour).Unix()
		primary := map[string]any{
			"used_percent": usedPercent, "reset_at": resetPrimary,
			"limit_window_seconds": 5 * 60 * 60,
		}
		var secondary any = map[string]any{
			"used_percent": usedPercent / 2, "reset_at": resetWeekly,
			"limit_window_seconds": 7 * 24 * 60 * 60,
		}
		if weeklyOnly {
			primary = map[string]any{
				"used_percent":         usedPercent,
				"limit_window_seconds": 7 * 24 * 60 * 60,
			}
			secondary = nil
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"plan_type": "pro",
			"rate_limit": map[string]any{
				"primary_window": primary, "secondary_window": secondary,
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
	weeklyOnly = true
	codex.RefreshQuotaUpstream(codexCard, "", codexLease, true)
	if quota := codex.LatestCodexQuota(); quota == nil || quota.HourlyPresent == nil || *quota.HourlyPresent ||
		quota.WeeklyPresent == nil || !*quota.WeeklyPresent || quota.HourlyPercent != -1 || quota.WeeklyPercent != 80 {
		t.Fatalf("weekly-only upstream was not normalized: %+v", quota)
	}
	_ = codex.ConsumeCodexQuotaSnapshot() // force snapshot-before-usage ordering
	codex.ReportUsage(codexCard, "go-e2e-codex", ReportDetails{
		StatusCode: 200, ModelKey: "gpt-5.6-sol",
		InputTokens: 1_000_000, RawTotalTokens: 1_000_000, BillableTotalTokens: 1_000_000,
		RequestStartedAt:    time.Now().Add(-2 * time.Second).UnixMilli(),
		UpstreamCompletedAt: time.Now().Add(-time.Second).UnixMilli(),
		ServiceTier:         "priority", Surface: "desktop",
	}, "", codexLease)
	if fairShareCacheHasForTest("codex-gpt") {
		t.Fatal("Codex entered the retired local fair-share cache")
	}
	// 再租一次,强制从服务端持久状态回传窗口。若服务端仍保留旧5h,这里会重新变成 hourlyPresent=true。
	if _, err := codex.LeaseToken(codexCard, "go-e2e-codex", true, map[string]any{
		"modelKey": "gpt-5.6-sol",
	}, ""); err != nil {
		t.Fatalf("Codex weekly-only re-lease: %v", err)
	}
	if quota := codex.LatestCodexQuota(); quota == nil || quota.HourlyPresent == nil || *quota.HourlyPresent ||
		quota.WeeklyPresent == nil || !*quota.WeeklyPresent || quota.HourlyPercent != -1 || quota.WeeklyPercent != 80 {
		t.Fatalf("server did not persist/return weekly-only state: %+v", quota)
	}
	// 上游临时返回空 rate_limit 时必须保持刚才的 weekly-only 状态,不能清血条或复活 5h 窗口。
	emptyUsage = true
	codex.RefreshQuotaUpstream(codexCard, "", codexLease, true)
	if quota := codex.LatestCodexQuota(); quota == nil || quota.HourlyPresent == nil || *quota.HourlyPresent ||
		quota.WeeklyPresent == nil || !*quota.WeeklyPresent || quota.HourlyPercent != -1 || quota.WeeklyPercent != 80 {
		t.Fatalf("empty usage clobbered weekly-only client state: %+v", quota)
	}

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
	if fairShareCacheHasForTest("anthropic-claude") {
		t.Fatal("Anthropic entered the retired local fair-share cache")
	}

	// Wails stats must not expose mother-account or legacy personal-fraction bars.
	// The UI obtains only subscription USD windows through app heartbeat.
	stats := (&App{}).GetStats()
	leaserStats, ok := stats["leaser"].(map[string]interface{})
	if !ok {
		t.Fatalf("GetStats leaser payload type = %T", stats["leaser"])
	}
	for _, key := range []string{"accountFractions", "accountResetMs", "accountResetAt", "codexQuota", "claudeQuota", "boundAccounts", "myPersonalFractions", "myPersonalWeeklyFractions"} {
		if _, exists := leaserStats[key]; exists {
			t.Fatalf("GetStats unexpectedly exposed %s: %#v", key, leaserStats[key])
		}
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

	// A rollout response from an old server must not revive Codex fair-share state.
	recordFairShareQuota([]byte(`{
		"accountBuckets":{"codex-gpt":{"fraction":0.5,"resetAt":1000}},
		"fairShareQuota":{"codex-gpt":{"fraction":0.4,"resetAt":2000,"share":1}},
		"weeklyFairShareQuota":{"codex-gpt":{"fraction":0.3,"resetAt":3000}}
	}`))
	if fairShareCacheHasForTest("codex-gpt") {
		t.Fatal("old-server response revived Codex fair-share state")
	}

	// 会话切换仍清理运行时额度，但不删除本机用量历史。
	globalUsageStats.AddModelTokens("gpt", "gpt-5.6-luna", 123, 45, 0, 168, false)
	usageBefore := globalUsageStats.GetTodayRecord()
	usageBeforeClear := usageBefore.InputTokens + usageBefore.OutputTokens + usageBefore.CachedTokens + usageBefore.CacheWriteTokens
	clearLocalCardState()
	usageAfter := globalUsageStats.GetTodayRecord()
	if usageAfterClear := usageAfter.InputTokens + usageAfter.OutputTokens + usageAfter.CachedTokens + usageAfter.CacheWriteTokens; usageAfterClear != usageBeforeClear {
		t.Fatalf("clearLocalCardState deleted usage history: before=%d after=%d", usageBeforeClear, usageAfterClear)
	}
	t.Logf("production leasers completed against %s (%s, %s)", base, fmt.Sprint(codexLease.AccountId), fmt.Sprint(claudeLease.AccountId))
}

// TestQuotaPendingQueueE2E drives the production retry queue through a real
// HTTP transport failure and recovery. The old offset bug duplicated the failed
// item when an expired item preceded it. Card fields may contain expired JWTs;
// the user-scoped queue retries all live reports with the current JWT.
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
	wantAccepted := []string{"other-card", "failed", "untouched"}
	if len(gotAccepted) != len(wantAccepted) {
		t.Fatalf("accepted reports=%v, want %v", gotAccepted, wantAccepted)
	}
	for index := range wantAccepted {
		if gotAccepted[index] != wantAccepted[index] {
			t.Fatalf("accepted reports=%v, want %v", gotAccepted, wantAccepted)
		}
	}
}
