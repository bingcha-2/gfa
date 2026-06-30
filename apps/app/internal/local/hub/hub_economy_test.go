package hub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/economy"
)

func TestHub_EconomyStoresRoundTrip(t *testing.T) {
	// 沙箱化 Codex 主目录:SetAppSpeed 会真写 config.toml,不能落到开发机的 ~/.codex。
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	h, _ := newHub(t)

	if _, err := h.SetAlertConfig(economy.AlertConfig{Enabled: true, ThresholdPct: 15}); err != nil {
		t.Fatalf("SetAlertConfig: %v", err)
	}
	if got := h.GetAlertConfig(); !got.Enabled || got.ThresholdPct != 15 {
		t.Fatalf("alert config round-trip: %+v", got)
	}

	if _, err := h.SetSwitchConfig(economy.SwitchConfig{
		Enabled: true, ThresholdPct: 20, ScopeMode: economy.ScopeSelected,
		SelectedAccountIDs: []string{"x"},
	}); err != nil {
		t.Fatalf("SetSwitchConfig: %v", err)
	}
	if got := h.GetSwitchConfig(); !got.Enabled || got.ScopeMode != economy.ScopeSelected || len(got.SelectedAccountIDs) != 1 {
		t.Fatalf("switch config round-trip: %+v", got)
	}

	if _, err := h.SetAppSpeed(economy.AppSpeed{ContextPreset: economy.Preset1M, Tier: economy.TierFast}); err != nil {
		t.Fatalf("SetAppSpeed: %v", err)
	}
	if got := h.GetAppSpeed(); got.ContextPreset != economy.Preset1M || got.Tier != economy.TierFast {
		t.Fatalf("speed round-trip: %+v", got)
	}
	// 「快速」必须真落到 config.toml,而不只是存进 app-speed.json(原 STUB bug)。
	toml, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if !strings.Contains(string(toml), `default-service-tier = "priority"`) {
		t.Fatalf("SetAppSpeed(fast) 应写 config.toml [desktop].default-service-tier:\n%s", toml)
	}
}

func TestHub_EconomyViewAdapter(t *testing.T) {
	a := &account.Account{
		ID: "id1", Email: "a@x.com", QuotaStatus: account.QuotaOK,
		HourlyPercent: 40, WeeklyPercent: 80,
		HourlyResetAt: 1700000000000, WeeklyResetAt: 0,
	}
	v := economyView(a)
	if !v.HasQuota || v.HourlyPercent != 40 || v.WeeklyPercent != 80 {
		t.Fatalf("view percents wrong: %+v", v)
	}
	if v.HourlyWindowPresent == nil || !*v.HourlyWindowPresent {
		t.Fatalf("hourly window should be present")
	}
	if v.WeeklyWindowPresent == nil || *v.WeeklyWindowPresent {
		t.Fatalf("weekly window should be absent (reset_at=0)")
	}
	if v.Cooling {
		t.Fatalf("QuotaOK should not be cooling")
	}

	cool := &account.Account{ID: "id2", QuotaStatus: account.QuotaExhausted}
	if !economyView(cool).Cooling {
		t.Fatalf("exhausted should be cooling")
	}
}

// 当前(优先级)号超额且有更空闲候选时,RefreshAllQuotas 后自动把候选置优先级;
// 若处于 local 接管态,还重注入新优先级号到 ~/.codex/auth.json。
func TestHub_AutoSwitchFlipsPriorityAndReinjects(t *testing.T) {
	h, fp := newHub(t)
	// 关闭后台续约对优先级的干扰:本测试只走显式 RefreshAllQuotas 路径。
	low := &account.Account{
		ID: "low", Provider: account.ProviderCodex, Email: "low@x.com",
		AuthKind: account.AuthAPIKey, APIKey: "k", PoolEnabled: true, Priority: true,
		QuotaStatus: account.QuotaOK, HourlyPercent: 5, WeeklyPercent: 5,
		HourlyResetAt: 1, WeeklyResetAt: 1,
	}
	high := &account.Account{
		ID: "high", Provider: account.ProviderCodex, Email: "high@x.com",
		AuthKind: account.AuthAPIKey, APIKey: "k", PoolEnabled: true,
		QuotaStatus: account.QuotaOK, HourlyPercent: 90, WeeklyPercent: 90,
		HourlyResetAt: 1, WeeklyResetAt: 1,
	}
	if err := h.acc.Add(low); err != nil {
		t.Fatalf("add low: %v", err)
	}
	if err := h.acc.Add(high); err != nil {
		t.Fatalf("add high: %v", err)
	}

	if _, err := h.SetSwitchConfig(economy.SwitchConfig{Enabled: true, ThresholdPct: 20, ScopeMode: economy.ScopeAll}); err != nil {
		t.Fatalf("SetSwitchConfig: %v", err)
	}
	// 进入 local 接管态(会注入一次 low);随后清零计数,只观察自动切号的重注入。
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("SetSource local: %v", err)
	}
	fp.codexInjectCount = 0
	fp.codexRestoreCount = 0

	// API Key 号 FetchQuota 满血占位会覆盖百分比 -> 这里直接调评估,避免上游探测改写。
	h.maybeAutoSwitchCodex()

	cur, err := h.currentAccount(account.ProviderCodex)
	if err != nil || cur == nil {
		t.Fatalf("currentAccount: %v %v", cur, err)
	}
	if cur.ID != "high" {
		t.Fatalf("expected auto-switch to high, current=%s", cur.ID)
	}
	if fp.codexInjectCount == 0 {
		t.Fatalf("expected re-inject after auto-switch in local takeover")
	}
}

func TestHub_AutoSwitchDisabledNoop(t *testing.T) {
	h, _ := newHub(t)
	low := &account.Account{
		ID: "low", Provider: account.ProviderCodex, AuthKind: account.AuthAPIKey,
		PoolEnabled: true, Priority: true, QuotaStatus: account.QuotaOK,
		HourlyPercent: 1, WeeklyPercent: 1, HourlyResetAt: 1, WeeklyResetAt: 1,
	}
	high := &account.Account{
		ID: "high", Provider: account.ProviderCodex, AuthKind: account.AuthAPIKey,
		PoolEnabled: true, QuotaStatus: account.QuotaOK,
		HourlyPercent: 90, WeeklyPercent: 90, HourlyResetAt: 1, WeeklyResetAt: 1,
	}
	_ = h.acc.Add(low)
	_ = h.acc.Add(high)
	// 默认 switch 配置 Enabled=false。
	h.maybeAutoSwitchCodex()
	cur, _ := h.currentAccount(account.ProviderCodex)
	if cur == nil || cur.ID != "low" {
		t.Fatalf("disabled auto-switch must keep current=low, got %+v", cur)
	}
}
