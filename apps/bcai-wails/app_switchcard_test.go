package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// stubActivateServer 把包级 API_BASE 指向一个返回「激活失败」的测试服务器,
// 让 GetLeaser().Activate 快速报错 —— 于是 ActivateCard 在 StartAutoLease 之前
// early-return,不起后台 goroutine、不打生产域名;而换卡清零判断已在更早的
// switchCardConfig 完成,正是这些回归用例要锁住的环节。
func stubActivateServer(t *testing.T) {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":false,"code":"TEST_STUB"}`))
	}))
	oldBase := API_BASE
	API_BASE = ts.URL
	t.Cleanup(func() {
		API_BASE = oldBase
		ts.Close()
	})
}

// 复现 bug:Dashboard「激活」换卡走 ActivateCard → 包级 SaveConfig,绕过清零,
// 导致旧卡的 today token / 血条残量串到新卡。switchCardConfig 是抽出来的可测继叝:
// 卡变化才清零,重激活同卡不动当天数据。
func TestSwitchCardConfigClearsStaleStatsOnChange(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // 隔离 getAppDataDir → 临时目录
	GetUsageStats().Reset()
	resetBoundFractions()

	// 旧卡 A:攒下 today 用量 + 绑定号血条残量。
	if err := SaveConfig(Config{AccountCard: "cardA"}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}
	GetUsageStats().AddTokens("claude", 31_700, 47_300, 0, 79_000)
	recordAccountBucketFraction("anthropic-claude", 0.3, 0)
	if GetUsageStats().GetTodayRecord().InputTokens == 0 {
		t.Fatal("前置失败:today 应有数据")
	}

	// 换到不同卡 B —— 必须清零。
	cfg, switched := switchCardConfig("cardB")
	if !switched {
		t.Fatal("换到不同卡应判定为 switched")
	}
	if cfg.AccountCard != "cardB" {
		t.Fatalf("配置应写入新卡, 得到 %q", cfg.AccountCard)
	}
	if got := GetUsageStats().GetTodayRecord(); got.InputTokens != 0 || got.OutputTokens != 0 {
		t.Fatalf("换卡后 today token 应清零, 得到 %+v", got)
	}
	if n := len(snapshotAccountFractions()); n != 0 {
		t.Fatalf("换卡后血条应清零, 仍残留 %d 个 bucket", n)
	}
}

// 重激活同一张卡:不应清空当天数据(否则用户重输同卡会丢统计)。
func TestSwitchCardConfigKeepsStatsOnSameCard(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	GetUsageStats().Reset()
	resetBoundFractions()

	if err := SaveConfig(Config{AccountCard: "cardB"}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}
	GetUsageStats().AddTokens("claude", 100, 200, 0, 300)

	_, switched := switchCardConfig("cardB")
	if switched {
		t.Fatal("重激活同卡不应判定为 switched")
	}
	if GetUsageStats().GetTodayRecord().InputTokens != 100 {
		t.Fatalf("重激活同卡不应清空当天数据, 得到 %+v", GetUsageStats().GetTodayRecord())
	}
}

// 回归:Dashboard「激活」按钮的真实路径(ActivateCard)在同卡时不得清空统计。
// 防止以后有人改 ActivateCard 又绕过 switchCardConfig 的同卡守卫。
func TestActivateCardSameCardPreservesStats(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	GetUsageStats().Reset()
	resetBoundFractions()
	stubActivateServer(t)

	if err := SaveConfig(Config{AccountCard: "cardA"}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}
	GetUsageStats().AddTokens("claude", 31_700, 47_300, 0, 79_000)

	app := &App{}
	_, _ = app.ActivateCard("cardA") // 同卡再点激活(Activate 失败不影响断言)

	if got := GetUsageStats().GetTodayRecord(); got.InputTokens != 31_700 || got.OutputTokens != 47_300 {
		t.Fatalf("同卡激活不应清空统计, 得到 %+v", got)
	}
	if LoadConfig().AccountCard != "cardA" {
		t.Fatal("卡未变,配置应仍为 cardA")
	}
}

// 回归:ActivateCard 换到不同卡时,经 switchCardConfig 清空统计 + 血条,并写入新卡。
func TestActivateCardDifferentCardClearsStats(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	GetUsageStats().Reset()
	resetBoundFractions()
	stubActivateServer(t)

	if err := SaveConfig(Config{AccountCard: "cardA"}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}
	GetUsageStats().AddTokens("claude", 31_700, 47_300, 0, 79_000)
	recordAccountBucketFraction("anthropic-claude", 0.3, 0)

	app := &App{}
	_, _ = app.ActivateCard("cardB") // 换不同卡

	if got := GetUsageStats().GetTodayRecord(); got.InputTokens != 0 || got.OutputTokens != 0 {
		t.Fatalf("换不同卡应清空统计, 得到 %+v", got)
	}
	if n := len(snapshotAccountFractions()); n != 0 {
		t.Fatalf("换不同卡应清空血条, 仍残留 %d 个 bucket", n)
	}
	if LoadConfig().AccountCard != "cardB" {
		t.Fatal("配置应已写入 cardB")
	}
}

// 换卡必须清掉【三家】leaser 的 lastError —— 否则旧卡的「卡额度已用完」红 banner 会一直挂着
// (换了新卡 / 后台加了额度也不消失)。三家逻辑一致。
func TestSwitchCardClearsAllLeaserErrors(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	GetUsageStats().Reset()
	resetBoundFractions()

	if err := SaveConfig(Config{AccountCard: "cardA"}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}
	// 三家都攒下「额度已用完」错误(就是那个红 banner 的来源)。
	GetLeaser().setLastError("卡额度已用完:antigravity ...")
	GetClaudeLeaser().setLastError("卡额度已用完:claude ...")
	GetCodexLeaser().setLastError("卡额度已用完:codex ...")

	// 换到不同卡 → 必须把三家错误一起清空。
	if _, switched := switchCardConfig("cardB"); !switched {
		t.Fatal("换到不同卡应判定为 switched")
	}
	if e := GetLeaser().LastError(); e != "" {
		t.Fatalf("antigravity lastError 应清空, got %q", e)
	}
	if e := GetClaudeLeaser().LastError(); e != "" {
		t.Fatalf("claude lastError 应清空, got %q", e)
	}
	if e := GetCodexLeaser().LastError(); e != "" {
		t.Fatalf("codex lastError 应清空, got %q", e)
	}
}
