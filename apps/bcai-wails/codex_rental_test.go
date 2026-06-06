package main

import "testing"

// 接管即租号:ensureCodexRentalMode 必须把遗留的 relay 中转配置彻底清掉并切回 rental。
func TestEnsureCodexRentalMode_ClearsRelay(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // 隔离 getAppDataDir → 临时目录

	// 前置:一份完整的 relay(litellm 中转)配置。
	if err := SaveConfig(Config{
		CodexMode:          "relay",
		CodexRelayBase:     "https://litellm.bg.huohua.cn",
		CodexRelayKey:      "sk-secret",
		CodexRelayProtocol: "chat",
		CodexModelMap:      map[string]string{"gpt-5.5": "volcengine/doubao-seed-1-6-251015"},
	}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}

	changed, err := ensureCodexRentalMode()
	if err != nil {
		t.Fatalf("ensureCodexRentalMode 出错: %v", err)
	}
	if !changed {
		t.Fatal("有 relay 残留时应返回 changed=true")
	}

	got := LoadConfig()
	if got.CodexMode != "rental" {
		t.Errorf("CodexMode = %q, 期望 rental", got.CodexMode)
	}
	if got.CodexRelayBase != "" || got.CodexRelayKey != "" || got.CodexRelayProtocol != "" {
		t.Errorf("中转 base/key/protocol 未清空: %+v", got)
	}
	if len(got.CodexModelMap) != 0 {
		t.Errorf("CodexModelMap 未清空: %v", got.CodexModelMap)
	}

	// 落地后 relayConfigFromConfig 必须判定为非中转(返回 nil)。
	if r := relayConfigFromConfig(got); r != nil {
		t.Errorf("清理后仍被判为中转模式: %+v", r)
	}
}

// 已是纯租号(无任何中转残留)时为 no-op,不应重写配置。
func TestEnsureCodexRentalMode_NoopWhenRental(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	if err := SaveConfig(Config{AccountCard: "card-x"}); err != nil {
		t.Fatalf("前置 SaveConfig 失败: %v", err)
	}

	changed, err := ensureCodexRentalMode()
	if err != nil {
		t.Fatalf("ensureCodexRentalMode 出错: %v", err)
	}
	if changed {
		t.Fatal("无中转残留时应返回 changed=false(no-op)")
	}
}
