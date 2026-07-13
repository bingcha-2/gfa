package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func boolValue(v *bool) (bool, bool) {
	if v == nil {
		return false, false
	}
	return *v, true
}

func TestParseCodexUsageClassifiesWeeklyWindowByDuration(t *testing.T) {
	used := 20.0
	weeklySeconds := int64(7 * 24 * 60 * 60)
	u := &codexUsageResponse{
		RateLimit: &codexUsageRateLimit{
			PrimaryWindow: &codexUsageWindow{
				UsedPercent:        &used,
				LimitWindowSeconds: &weeklySeconds,
			},
		},
	}

	w := parseCodexUsage(u)
	if w == nil {
		t.Fatal("expected quota window")
	}
	if w.HourlyPercent != -1 || w.WeeklyPercent != 80 {
		t.Fatalf("weekly-in-primary parsed as hourly=%v weekly=%v, want -1/80", w.HourlyPercent, w.WeeklyPercent)
	}
	if present, known := boolValue(w.HourlyPresent); !known || present {
		t.Fatalf("hourly presence = %v/%v, want known false", present, known)
	}
	if present, known := boolValue(w.WeeklyPresent); !known || !present {
		t.Fatalf("weekly presence = %v/%v, want known true", present, known)
	}
}

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

// 契约:窗口"在"但 used_percent 为 nil 时,必须报 -1(未知),不能伪造满血 100。
// 这曾是线上 accountId=19 等 13 个 codex 号"真27↔假100"抖动的源头:上游窗口在、used_percent 缺失
// → 旧代码 codexRemainingPercent(nil)=100 → 灌进 fair-share 假基线。c41aea4f 只修了"窗口整个缺失",
// 漏了"窗口在、used=null"这一内层洞,本测试封住它。used=0(真满血)仍应 → 100。
func TestParseCodexUsagePresentWindowNilUsedReportsUnknown(t *testing.T) {
	// primary/secondary 窗口都"在",但 used_percent 都为 nil(上游未返回该字段)→ -1。
	u := &codexUsageResponse{
		RateLimit: &codexUsageRateLimit{
			PrimaryWindow:   &codexUsageWindow{UsedPercent: nil},
			SecondaryWindow: &codexUsageWindow{UsedPercent: nil},
		},
	}
	w := parseCodexUsage(u)
	if w == nil {
		t.Fatalf("expected a window, got nil")
	}
	if w.HourlyPercent != -1 || w.WeeklyPercent != -1 {
		t.Fatalf("window 在但 used=null 必须报 -1/-1(未知),却得 %v/%v(伪造满血会毒化 fair-share)", w.HourlyPercent, w.WeeklyPercent)
	}

	// 对照:used_percent=0 是真·满血,必须 → 100(区分"未知"与"真满")。
	zero := 0.0
	u2 := &codexUsageResponse{RateLimit: &codexUsageRateLimit{PrimaryWindow: &codexUsageWindow{UsedPercent: &zero}}}
	if w2 := parseCodexUsage(u2); w2 == nil || w2.HourlyPercent != 100 {
		t.Fatalf("used=0 应为真满血 100,却得 %v", w2)
	}
}

// rate_limit 整段缺失 → 无快照(nil),而不是一份全 -1/100 的快照。
func TestParseCodexUsageNoRateLimitReturnsNil(t *testing.T) {
	if got := parseCodexUsage(&codexUsageResponse{}); got != nil {
		t.Fatalf("no rate_limit should yield nil snapshot, got %+v", got)
	}
}

func TestParseCodexUsageEmptyRateLimitKeepsPresenceUnknown(t *testing.T) {
	w := parseCodexUsage(&codexUsageResponse{RateLimit: &codexUsageRateLimit{}})
	if w == nil {
		t.Fatal("empty rate_limit should yield an unknown snapshot")
	}
	if w.HourlyPresent != nil || w.WeeklyPresent != nil {
		t.Fatalf("empty rate_limit must keep presence unknown, got hourly=%v weekly=%v", w.HourlyPresent, w.WeeklyPresent)
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

func TestApplyCodexWindowsClearsPreviousAccountWhenNewAccountHasNoSnapshot(t *testing.T) {
	l := &CodexLeaser{
		lastLease: &CodexTokenLease{AccountId: 2},
		lastQuota: &CodexAccountQuotaSnapshot{
			AccountId: 1,
			CodexQuota: &CodexQuotaWindow{HourlyPercent: 50, WeeklyPercent: 50},
		},
	}

	l.applyCodexWindows(nil)

	if got := l.LatestCodexQuota(); got != nil {
		t.Fatalf("new account inherited previous account quota: %+v", got)
	}
}

func TestFetchCodexQuotaEmptyRateLimitKeepsExisting(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"plan_type":"pro","rate_limit":{}}`))
	}))
	defer srv.Close()
	oldURL := CODEX_USAGE_URL
	CODEX_USAGE_URL = srv.URL
	t.Cleanup(func() { CODEX_USAGE_URL = oldURL })

	l := &CodexLeaser{lastQuota: &CodexAccountQuotaSnapshot{CodexQuota: &CodexQuotaWindow{
		HourlyPercent: 50, WeeklyPercent: 72,
	}}}
	l.fetchCodexQuotaAsync(&CodexTokenLease{AccessToken: "not-a-jwt"}, "")

	got := l.LatestCodexQuota()
	if got == nil || got.HourlyPercent != 50 || got.WeeklyPercent != 72 {
		t.Fatalf("empty rate_limit clobbered existing snapshot: %+v", got)
	}
	if snap := l.ConsumeCodexQuotaSnapshot(); snap != nil {
		t.Fatalf("empty rate_limit must not enqueue a quota report: %+v", snap)
	}
}

func TestFetchCodexQuotaPartialUnknownKeepsPriorOtherWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":10}}}`))
	}))
	defer srv.Close()
	oldURL := CODEX_USAGE_URL
	CODEX_USAGE_URL = srv.URL
	t.Cleanup(func() { CODEX_USAGE_URL = oldURL })

	l := &CodexLeaser{lastQuota: &CodexAccountQuotaSnapshot{CodexQuota: &CodexQuotaWindow{
		HourlyPercent: 50, WeeklyPercent: 72,
	}}}
	l.fetchCodexQuotaAsync(&CodexTokenLease{AccessToken: "not-a-jwt"}, "")

	got := l.LatestCodexQuota()
	if got == nil || got.HourlyPercent != 90 || got.WeeklyPercent != 72 {
		t.Fatalf("partial response should update hourly and keep weekly: %+v", got)
	}
}

func TestFetchCodexQuotaDoesNotMergeDisplayAcrossAccounts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"rate_limit":{"primary_window":{"used_percent":10}}}`))
	}))
	defer srv.Close()
	oldURL := CODEX_USAGE_URL
	CODEX_USAGE_URL = srv.URL
	t.Cleanup(func() { CODEX_USAGE_URL = oldURL })

	l := &CodexLeaser{lastQuota: &CodexAccountQuotaSnapshot{AccountId: 1, CodexQuota: &CodexQuotaWindow{
		HourlyPercent: 50, WeeklyPercent: 72,
	}}}
	l.fetchCodexQuotaAsync(&CodexTokenLease{AccessToken: "not-a-jwt", AccountId: 2}, "")

	got := l.LatestCodexQuota()
	if got == nil || got.HourlyPercent != 90 || got.WeeklyPercent != -1 {
		t.Fatalf("new account inherited previous account quota: %+v", got)
	}
}
