package main

import "testing"

// 缺失的限额窗口必须报 -1(未知),不能伪装成满血 100 —— 否则服务端 fair-share 低水位被抬到
// ~1.0,下次真实低值回来时整段跌幅一次性归因给在场卡,血条卡死 0 而母号已恢复(与 Claude 同口径)。
func TestParseCodexUsageAbsentWindowReportsUnknownNotFull(t *testing.T) {
	used := 4.0
	// 只有 5h(primary)窗口;weekly(secondary)缺失。
	u := &codexUsageResponse{
		RateLimit: &codexUsageRateLimit{
			PrimaryWindow: &codexUsageWindow{UsedPercent: &used},
		},
	}
	w := parseCodexUsage(u)
	if w == nil {
		t.Fatalf("expected a window, got nil")
	}
	if w.HourlyPercent != 96 { // 100 - 4
		t.Fatalf("hourly = %v, want 96", w.HourlyPercent)
	}
	if w.WeeklyPercent != -1 {
		t.Fatalf("缺失 weekly 必须报 -1(未知),却得 %v(伪装满血会污染 fair-share)", w.WeeklyPercent)
	}
}

// rate_limit 整段缺失 → 无快照(nil),而不是一份全 -1/100 的快照。
func TestParseCodexUsageNoRateLimitReturnsNil(t *testing.T) {
	if got := parseCodexUsage(&codexUsageResponse{}); got != nil {
		t.Fatalf("no rate_limit should yield nil snapshot, got %+v", got)
	}
}

// The codex lease response carries the bound account's 5h+weekly windows
// (codexWindows). Applying it must make LatestCodexQuota() return those windows
// so the dashboard renders both codex bars (5h / 周) with real percentages —
// without the client having to fetch upstream usage itself.
func TestApplyCodexWindowsPopulatesLatestQuota(t *testing.T) {
	l := &CodexLeaser{}
	if l.LatestCodexQuota() != nil {
		t.Fatalf("expected nil quota before any windows applied")
	}

	l.applyCodexWindows(&CodexQuotaWindow{
		HourlyPercent:   80,
		WeeklyPercent:   30,
		HourlyResetTime: "2026-06-01T10:00:00Z",
		WeeklyResetTime: "2026-06-05T00:00:00Z",
	})

	got := l.LatestCodexQuota()
	if got == nil {
		t.Fatalf("expected quota after applyCodexWindows, got nil")
	}
	if got.HourlyPercent != 80 || got.WeeklyPercent != 30 {
		t.Fatalf("percentages = %v/%v, want 80/30", got.HourlyPercent, got.WeeklyPercent)
	}
	if got.WeeklyResetTime != "2026-06-05T00:00:00Z" {
		t.Fatalf("weekly reset = %q", got.WeeklyResetTime)
	}
}

// A nil/empty windows payload must not clobber an existing snapshot.
func TestApplyCodexWindowsNilKeepsExisting(t *testing.T) {
	l := &CodexLeaser{}
	l.applyCodexWindows(&CodexQuotaWindow{HourlyPercent: 50, WeeklyPercent: 50})
	l.applyCodexWindows(nil)
	if got := l.LatestCodexQuota(); got == nil || got.HourlyPercent != 50 {
		t.Fatalf("nil windows clobbered existing quota: %+v", got)
	}
}
