package main

import (
	"testing"
	"time"
)

func TestRecordAndSnapshotBoundFractions(t *testing.T) {
	boundFractions = map[string]bucketQuota{} // reset

	recordBoundFractionForModel("gemini-2.5-pro", 0.42, 0)
	recordBoundFractionForModel("gpt-5-codex", 0.10, 0)
	recordBoundFractionForModel("claude-opus-4-6", 0.88, 0)

	s := snapshotBoundFractions()
	if s["gemini"] != 0.42 || s["codex"] != 0.10 || s["opus"] != 0.88 {
		t.Fatalf("分桶不对: %v", s)
	}

	// 空 modelKey(探针)忽略,不写入空 bucket。
	recordBoundFractionForModel("", 0.5, 0)
	if _, ok := snapshotBoundFractions()[""]; ok {
		t.Fatal("空 modelKey 不应写入")
	}

	// snapshot 是拷贝,改它不影响内部。
	s["gemini"] = 9
	if snapshotBoundFractions()["gemini"] != 0.42 {
		t.Fatal("snapshot 应是拷贝")
	}
}

func TestSnapshotBoundResets(t *testing.T) {
	boundFractions = map[string]bucketQuota{} // reset
	now := int64(1_000_000)
	recordBoundFractionForModel("claude-opus-4-6", 0, now+3_600_000) // 1h 后恢复
	recordBoundFractionForModel("gemini-2.5-pro", 0.8, 0)            // 无 reset
	recordBoundFractionForModel("gpt-5-codex", 0.5, now-100)         // 已过 → 0

	r := snapshotBoundResets(now)
	if r["opus"] != 3_600_000 {
		t.Fatalf("opus resetMs 应为 1h, 得到 %v", r["opus"])
	}
	if _, ok := r["gemini"]; ok {
		t.Fatal("无 reset 的 bucket 不应出现")
	}
	if r["codex"] != 0 {
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
