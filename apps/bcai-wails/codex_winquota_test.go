package main

import "testing"

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
