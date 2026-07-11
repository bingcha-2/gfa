package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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
		return primary && weekly
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
		return primary && weekly
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
	t.Logf("production leasers completed against %s (%s, %s)", base, fmt.Sprint(codexLease.AccountId), fmt.Sprint(claudeLease.AccountId))
}
