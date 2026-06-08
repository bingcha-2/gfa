package main

import (
	"testing"
	"time"
)

func clearBoundFractionsForTest() {
	boundFracMu.Lock()
	boundFractions = map[string]bucketQuota{}
	boundFracMu.Unlock()
}

func TestRecordAndSnapshotBoundFractions(t *testing.T) {
	clearBoundFractionsForTest()

	// Buckets are composite product-family — the same Claude model under
	// antigravity vs anthropic must land in distinct buckets.
	recordBoundFractionForModel("antigravity", "gemini-2.5-pro", 0.42, 0)
	recordBoundFractionForModel("codex", "gpt-5-codex", 0.10, 0)
	recordBoundFractionForModel("anthropic", "claude-opus-4-6", 0.88, 0)

	s := snapshotAccountFractions()
	if s["antigravity-gemini"] != 0.42 || s["codex-gpt"] != 0.10 || s["anthropic-claude"] != 0.88 {
		t.Fatalf("分桶不对: %v", s)
	}

	// 空 modelKey(探针)忽略,不写入空 bucket。
	recordBoundFractionForModel("antigravity", "", 0.5, 0)
	if _, ok := snapshotAccountFractions()["antigravity-"]; ok {
		t.Fatal("空 modelKey 不应写入")
	}

	// snapshot 是拷贝,改它不影响内部。
	s["antigravity-gemini"] = 9
	if snapshotAccountFractions()["antigravity-gemini"] != 0.42 {
		t.Fatal("snapshot 应是拷贝")
	}
}

func TestResetBoundFractions(t *testing.T) {
	clearBoundFractionsForTest()

	recordBoundFractionForModel("anthropic", "claude-opus-4-6", 0.30, 1_000_000)
	recordBoundFractionForModel("antigravity", "gemini-2.5-pro", 0.50, 0)
	if len(snapshotAccountFractions()) != 2 {
		t.Fatalf("前置失败:应有 2 个 bucket, 得到 %v", snapshotAccountFractions())
	}

	// 换卡:绑定号血条残量必须清零,否则旧卡的 84K/32K 会串到新卡。
	resetBoundFractions()

	if got := snapshotAccountFractions(); len(got) != 0 {
		t.Fatalf("换卡后血条应清零, 仍残留: %v", got)
	}
	// 倒计时也要一起清,避免旧卡 resetAt 残留。
	if got := snapshotAccountResets(2_000_000); len(got) != 0 {
		t.Fatalf("换卡后 reset 倒计时应清零, 仍残留: %v", got)
	}
}

func TestSnapshotBoundResets(t *testing.T) {
	clearBoundFractionsForTest()
	now := int64(1_000_000)
	recordBoundFractionForModel("anthropic", "claude-opus-4-6", 0, now+3_600_000) // 1h 后恢复
	recordBoundFractionForModel("antigravity", "gemini-2.5-pro", 0.8, 0)          // 无 reset
	recordBoundFractionForModel("codex", "gpt-5-codex", 0.5, now-100)             // 已过 → 0

	r := snapshotAccountResets(now)
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

// 整号(accountBuckets / boundAccount.fraction)与我的份额(fairShareQuota)是两个独立
// 维度,记录任一个都不该覆盖另一个。这是双血条的核心:绑定卡要同时显示「整个号还剩多少」
// +「我分到多少」。修复前 recordFairShareQuota 会整条覆盖 accountBuckets,丢掉整号那份。
func TestBucketQuotaTwoDimensionsIndependent(t *testing.T) {
	clearBoundFractionsForTest()
	const bucket = "antigravity-claude"

	recordAccountBucketFraction(bucket, 0.87, 1000) // 整号充足
	recordMyBucketFraction(bucket, 0.40, 2000)      // 我的份额紧张

	if got, ok := snapshotAccountFractions()[bucket]; !ok || got != 0.87 {
		t.Fatalf("account fraction = %v (ok=%v), want 0.87", got, ok)
	}
	if got, ok := snapshotMyFractions()[bucket]; !ok || got != 0.40 {
		t.Fatalf("my fraction = %v (ok=%v), want 0.40", got, ok)
	}

	// 反向写入顺序同样不该互相覆盖。
	clearBoundFractionsForTest()
	recordMyBucketFraction(bucket, 0.40, 2000)
	recordAccountBucketFraction(bucket, 0.87, 1000)
	if a, m := snapshotAccountFractions()[bucket], snapshotMyFractions()[bucket]; a != 0.87 || m != 0.40 {
		t.Fatalf("reverse order overwrote a dimension: account=%v my=%v", a, m)
	}
}

// 号池卡只有整号、没有 fair-share 份额:快照应只含已记录的那个维度,
// 这样前端能据此判断「该不该显示我的卡条」(无份额 → 降级单条)。
func TestSnapshotOnlyIncludesRecordedDimension(t *testing.T) {
	clearBoundFractionsForTest()
	recordAccountBucketFraction("codex-gpt", 0.9, 0)

	if _, ok := snapshotMyFractions()["codex-gpt"]; ok {
		t.Fatalf("my fractions should be empty when only account recorded")
	}
	if _, ok := snapshotAccountFractions()["codex-gpt"]; !ok {
		t.Fatalf("account fraction should be present")
	}
}

// 恢复倒计时也按维度各自给:号余量条用整号 reset,我的卡条用份额 reset,互不串。
func TestResetsArePerDimension(t *testing.T) {
	clearBoundFractionsForTest()
	const bucket = "antigravity-gemini"
	now := int64(10_000)
	recordAccountBucketFraction(bucket, 0.5, now+60_000) // 整号 60s 后恢复
	recordMyBucketFraction(bucket, 0.2, now+30_000)      // 份额 30s 后恢复

	if got := snapshotAccountResets(now)[bucket]; got != 60_000 {
		t.Fatalf("account reset = %v, want 60000", got)
	}
	if got := snapshotMyResets(now)[bucket]; got != 30_000 {
		t.Fatalf("my reset = %v, want 30000", got)
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
