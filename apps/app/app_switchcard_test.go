package main

import (
	"testing"
	"time"
)

// Quota/session clearing does not delete the active user's namespaced history.
func TestClearLocalCardState_PreservesUsageHistory(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	GetUsageStats().Reset()
	resetBoundFractions()

	// Accumulate some state
	GetUsageStats().AddTokens("claude", 31_700, 47_300, 0, 79_000)
	recordMyBucketFraction("antigravity-claude", 0, time.Now().Add(time.Hour).UnixMilli(), 1)
	GetLeaser().setLastError("卡额度已用完:antigravity ...")
	GetClaudeLeaser().setLastError("卡额度已用完:claude ...")
	GetCodexLeaser().setLastError("卡额度已用完:codex ...")

	if GetUsageStats().GetTodayRecord().InputTokens == 0 {
		t.Fatal("前置失败:today 应有数据")
	}

	// Clear state
	clearLocalCardState()

	if got := GetUsageStats().GetTodayRecord(); got.InputTokens != 31_700 || got.OutputTokens != 47_300 {
		t.Fatalf("会话切换不应删除 today token, 得到 %+v", got)
	}
	if n := fairShareCacheSizeForTest(); n != 0 {
		t.Fatalf("清空后 Antigravity fair-share 缓存应为零,仍残留 %d 个 bucket", n)
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

// TestSaveConfig_TokenChange_ClearsState verifies that when UserToken changes
// in SaveConfig, local state is cleared.
func TestSaveConfig_TokenChange_ClearsState(t *testing.T) {
	origConfigDir = t.TempDir()
	defer func() { origConfigDir = "" }()

	GetUsageStats().Reset()
	resetBoundFractions()

	// Set up initial token
	GetUsageStats().SwitchNamespace("user-a")
	if err := SaveConfig(Config{UserToken: "token-A", UserId: "user-a", DeviceId: "dev1", ProxyPort: 48800}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}
	GetUsageStats().AddTokens("claude", 100, 200, 0, 300)
	GetLeaser().setLastError("some-error")

	// Change token → should clear state
	app := &App{}
	if err := app.SaveConfig(Config{UserToken: "token-B", UserId: "user-b", DeviceId: "dev1", ProxyPort: 48800}); err != nil {
		t.Fatalf("SaveConfig failed: %v", err)
	}

	if got := GetUsageStats().GetTodayRecord(); got.InputTokens != 0 {
		t.Fatalf("换用户后不能串用上一用户的本机历史, 得到 %+v", got)
	}
	GetUsageStats().SwitchNamespace("user-a")
	if got := GetUsageStats().GetTodayRecord(); got.InputTokens != 100 {
		t.Fatalf("切回原用户应恢复其独立历史, 得到 %+v", got)
	}
	if e := GetLeaser().LastError(); e != "" {
		t.Fatalf("换 token 后 leaser error 应清空, got %q", e)
	}
	if LoadConfig().UserToken != "token-B" {
		t.Fatal("新 token 应已持久化")
	}
}

// TestSaveConfig_SameToken_KeepsState verifies that when UserToken is unchanged,
// SaveConfig does not clear local stats.
func TestSaveConfig_SameToken_KeepsState(t *testing.T) {
	origConfigDir = t.TempDir()
	defer func() { origConfigDir = "" }()

	GetUsageStats().Reset()
	resetBoundFractions()

	if err := SaveConfig(Config{UserToken: "token-X", DeviceId: "dev1", ProxyPort: 48800}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}
	GetUsageStats().AddTokens("claude", 100, 200, 0, 300)

	// Same token, only port change (but same port here, just re-save)
	app := &App{}
	if err := app.SaveConfig(Config{UserToken: "token-X", DeviceId: "dev1", ProxyPort: 48800}); err != nil {
		t.Fatalf("SaveConfig failed: %v", err)
	}

	if got := GetUsageStats().GetTodayRecord(); got.InputTokens != 100 {
		t.Fatalf("相同 token 不应清空统计, 得到 %+v", got)
	}
}
