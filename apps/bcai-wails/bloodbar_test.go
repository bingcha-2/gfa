package main

import (
	"testing"
	"time"
)

func TestRecordAndSnapshotBoundFractions(t *testing.T) {
	boundFractions = map[string]bucketQuota{} // reset

	// Buckets are composite product-family — the same Claude model under
	// antigravity vs anthropic must land in distinct buckets.
	recordBoundFractionForModel("antigravity", "gemini-2.5-pro", 0.42, 0)
	recordBoundFractionForModel("codex", "gpt-5-codex", 0.10, 0)
	recordBoundFractionForModel("anthropic", "claude-opus-4-6", 0.88, 0)

	s := snapshotBoundFractions()
	if s["antigravity-gemini"] != 0.42 || s["codex-gpt"] != 0.10 || s["anthropic-claude"] != 0.88 {
		t.Fatalf("分桶不对: %v", s)
	}

	// 空 modelKey(探针)忽略,不写入空 bucket。
	recordBoundFractionForModel("antigravity", "", 0.5, 0)
	if _, ok := snapshotBoundFractions()["antigravity-"]; ok {
		t.Fatal("空 modelKey 不应写入")
	}

	// snapshot 是拷贝,改它不影响内部。
	s["antigravity-gemini"] = 9
	if snapshotBoundFractions()["antigravity-gemini"] != 0.42 {
		t.Fatal("snapshot 应是拷贝")
	}
}

func TestSnapshotBoundResets(t *testing.T) {
	boundFractions = map[string]bucketQuota{} // reset
	now := int64(1_000_000)
	recordBoundFractionForModel("anthropic", "claude-opus-4-6", 0, now+3_600_000) // 1h 后恢复
	recordBoundFractionForModel("antigravity", "gemini-2.5-pro", 0.8, 0)          // 无 reset
	recordBoundFractionForModel("codex", "gpt-5-codex", 0.5, now-100)             // 已过 → 0

	r := snapshotBoundResets(now)
	if r["anthropic-claude"] != 3_600_000 {
		t.Fatalf("anthropic-claude resetMs 应为 1h, 得到 %v", r["anthropic-claude"])
	}
	if _, ok := r["antigravity-gemini"]; ok {
		t.Fatal("无 reset 的 bucket 不应出现")
	}
	if r["codex-gpt"] != 0 {
		t.Fatal("已过的 reset 应为 0")
	}
}

func TestCodexQuotaStatus(t *testing.T) {
	now := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	w := &CodexQuotaWindow{
		HourlyPercent:   70,
		WeeklyPercent:   40,
		HourlyResetTime: now.Add(2 * time.Hour).Format(time.RFC3339),
		WeeklyResetTime: now.Add(48 * time.Hour).Format(time.RFC3339),
	}
	s := codexQuotaStatus(w, now.UnixMilli())
	if s["hourlyFraction"].(float64) != 0.7 || s["weeklyFraction"].(float64) != 0.4 {
		t.Fatalf("分数不对: %v", s)
	}
	if s["hourlyResetMs"].(int64) != int64(2*3600*1000) {
		t.Fatalf("hourlyResetMs 不对: %v", s["hourlyResetMs"])
	}
	if s["weeklyResetMs"].(int64) != int64(48*3600*1000) {
		t.Fatalf("weeklyResetMs 不对: %v", s["weeklyResetMs"])
	}
	if codexQuotaStatus(nil, now.UnixMilli()) != nil {
		t.Fatal("nil window 应返回 nil")
	}
	// 已过的 reset → 0
	past := &CodexQuotaWindow{HourlyResetTime: now.Add(-time.Hour).Format(time.RFC3339)}
	if codexQuotaStatus(past, now.UnixMilli())["hourlyResetMs"].(int64) != 0 {
		t.Fatal("已过期的 reset 应为 0")
	}
}

func TestClaudeQuotaStatus(t *testing.T) {
	now := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	w := &ClaudeQuotaWindow{
		HourlyPercent:   55,
		WeeklyPercent:   30,
		HourlyResetTime: now.Add(3 * time.Hour).Format(time.RFC3339),
		WeeklyResetTime: now.Add(72 * time.Hour).Format(time.RFC3339),
	}
	s := claudeQuotaStatus(w, now.UnixMilli())
	if s["hourlyFraction"].(float64) != 0.55 || s["weeklyFraction"].(float64) != 0.3 {
		t.Fatalf("分数不对: %v", s)
	}
	if s["hourlyResetMs"].(int64) != int64(3*3600*1000) {
		t.Fatalf("hourlyResetMs 不对: %v", s["hourlyResetMs"])
	}
	if claudeQuotaStatus(nil, now.UnixMilli()) != nil {
		t.Fatal("nil window 应返回 nil")
	}
}
