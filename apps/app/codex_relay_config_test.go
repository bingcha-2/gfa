package main

import "testing"

// relayConfigFromConfig 只在 codexMode==relay 且 base/key 齐全时返回配置,否则 nil
// (nil → 走号池/租号模式)。
func TestRelayConfigFromConfig(t *testing.T) {
	t.Run("relay 模式且齐全 → 返回配置", func(t *testing.T) {
		cfg := Config{
			CodexMode:      "relay",
			CodexRelayBase: "https://relay.example.com",
			CodexRelayKey:  "sk-relay-123",
			CodexModelMap:  map[string]string{"gpt-5-codex": "claude"},
		}
		rc := relayConfigFromConfig(cfg)
		if rc == nil {
			t.Fatal("want non-nil relay config")
		}
		if rc.BaseURL != "https://relay.example.com" || rc.APIKey != "sk-relay-123" {
			t.Fatalf("unexpected relay config: %+v", rc)
		}
		if rc.ModelMap["gpt-5-codex"] != "claude" {
			t.Fatalf("model map not carried: %+v", rc.ModelMap)
		}
	})

	t.Run("默认模式 → nil(走号池)", func(t *testing.T) {
		if rc := relayConfigFromConfig(Config{CodexRelayBase: "x", CodexRelayKey: "y"}); rc != nil {
			t.Fatalf("非 relay 模式应返回 nil, got %+v", rc)
		}
	})

	t.Run("relay 模式但缺 key → nil", func(t *testing.T) {
		if rc := relayConfigFromConfig(Config{CodexMode: "relay", CodexRelayBase: "https://x"}); rc != nil {
			t.Fatalf("缺 key 应返回 nil, got %+v", rc)
		}
	})

	t.Run("relay 模式但缺 base → nil", func(t *testing.T) {
		if rc := relayConfigFromConfig(Config{CodexMode: "relay", CodexRelayKey: "sk-x"}); rc != nil {
			t.Fatalf("缺 base 应返回 nil, got %+v", rc)
		}
	})

	t.Run("大小写不敏感 + 去空白", func(t *testing.T) {
		cfg := Config{CodexMode: " Relay ", CodexRelayBase: " https://x ", CodexRelayKey: " k "}
		rc := relayConfigFromConfig(cfg)
		if rc == nil || rc.BaseURL != "https://x" || rc.APIKey != "k" {
			t.Fatalf("应去空白且大小写不敏感, got %+v", rc)
		}
	})
}
