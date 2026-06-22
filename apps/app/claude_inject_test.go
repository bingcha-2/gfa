package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func readClaudeSettings(t *testing.T) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(claudeSettingsPath())
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse settings.json: %v", err)
	}
	return m
}

func claudeEnvBlock(t *testing.T) map[string]interface{} {
	t.Helper()
	env, _ := readClaudeSettings(t)["env"].(map[string]interface{})
	return env
}

func TestInjectClaudeSettingsWritesEnvBlock(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)

	if IsClaudeInjected(8123) {
		t.Fatal("should not be injected before InjectClaudeSettings")
	}
	if err := InjectClaudeSettings(8123); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}

	env := claudeEnvBlock(t)
	if env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:8123" {
		t.Fatalf("ANTHROPIC_BASE_URL = %v, want http://127.0.0.1:8123", env["ANTHROPIC_BASE_URL"])
	}
	if token, _ := env["ANTHROPIC_AUTH_TOKEN"].(string); token == "" {
		t.Fatal("ANTHROPIC_AUTH_TOKEN must be a non-empty sentinel so Claude Code uses the base URL")
	}
	if !IsClaudeInjected(8123) {
		t.Fatal("IsClaudeInjected should be true after injection")
	}
}

func TestInjectClaudeSettingsPreservesUserKeys(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	// Pre-existing user settings with an unrelated key and an unrelated env var.
	seed := map[string]interface{}{
		"theme": "dark",
		"env":   map[string]interface{}{"MY_VAR": "keep-me"},
	}
	writeSeedSettings(t, dir, seed)

	if err := InjectClaudeSettings(9000); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	settings := readClaudeSettings(t)
	if settings["theme"] != "dark" {
		t.Fatalf("unrelated top-level key was lost: %v", settings["theme"])
	}
	env := claudeEnvBlock(t)
	if env["MY_VAR"] != "keep-me" {
		t.Fatalf("unrelated env var was lost: %v", env["MY_VAR"])
	}
	if env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:9000" {
		t.Fatalf("ANTHROPIC_BASE_URL not injected: %v", env["ANTHROPIC_BASE_URL"])
	}
}

func TestRestoreClaudeSettingsRemovesInjectedKeysWhenAbsentBefore(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"theme": "dark",
		"env":   map[string]interface{}{"MY_VAR": "keep-me"},
	})

	if err := InjectClaudeSettings(9000); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("RestoreClaudeSettings: %v", err)
	}

	settings := readClaudeSettings(t)
	if settings["theme"] != "dark" {
		t.Fatalf("unrelated key lost after restore: %v", settings["theme"])
	}
	env, _ := settings["env"].(map[string]interface{})
	if env == nil || env["MY_VAR"] != "keep-me" {
		t.Fatalf("unrelated env var lost after restore: %v", settings["env"])
	}
	if _, ok := env["ANTHROPIC_BASE_URL"]; ok {
		t.Fatalf("ANTHROPIC_BASE_URL should be removed on restore (was absent before): %v", env)
	}
	if _, ok := env["ANTHROPIC_AUTH_TOKEN"]; ok {
		t.Fatalf("ANTHROPIC_AUTH_TOKEN should be removed on restore: %v", env)
	}
	if _, ok := env["ANTHROPIC_API_KEY"]; ok {
		t.Fatalf("ANTHROPIC_API_KEY should be removed on restore (was absent before): %v", env)
	}
	if IsClaudeInjected(9000) {
		t.Fatal("IsClaudeInjected should be false after restore")
	}
}

// 注入必须把 ANTHROPIC_API_KEY 置「空串」(而非删除):空串经 Object.assign 覆盖
// shell/settings 里的真实 key,强制 claude 走哨兵 AUTH_TOKEN→代理,不进 API-key 模式。
func TestInjectClaudeSettingsNeutralizesApiKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"env": map[string]interface{}{"ANTHROPIC_API_KEY": "sk-user-real-key"},
	})

	if err := InjectClaudeSettings(9000); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	env := claudeEnvBlock(t)
	v, ok := env["ANTHROPIC_API_KEY"]
	if !ok {
		t.Fatal("ANTHROPIC_API_KEY must remain present (empty) to override shell — not deleted")
	}
	if v != "" {
		t.Fatalf("ANTHROPIC_API_KEY should be neutralized to empty string, got %v", v)
	}
}

func TestRestoreClaudeSettingsRestoresPriorApiKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"env": map[string]interface{}{"ANTHROPIC_API_KEY": "sk-user-real-key"},
	})

	if err := InjectClaudeSettings(7777); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	if claudeEnvBlock(t)["ANTHROPIC_API_KEY"] != "" {
		t.Fatal("api key not neutralized while injected")
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("RestoreClaudeSettings: %v", err)
	}
	if got := claudeEnvBlock(t)["ANTHROPIC_API_KEY"]; got != "sk-user-real-key" {
		t.Fatalf("prior api key not restored: %v", got)
	}
}

// 接管必须把 Foundry 键置「空串」(而非删除):CLAUDE_CODE_USE_FOUNDRY 优先级高于
// ANTHROPIC_BASE_URL,留着会让 CLI 走 Foundry endpoint 绕过本地代理。空串经 Object.assign
// 覆盖 shell 里 export 的 CLAUDE_CODE_USE_FOUNDRY=1,强制流量回到代理。
func TestInjectClaudeSettingsNeutralizesFoundry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"env": map[string]interface{}{
			"CLAUDE_CODE_USE_FOUNDRY":    "1",
			"ANTHROPIC_FOUNDRY_RESOURCE": "my-resource",
			"ANTHROPIC_FOUNDRY_BASE_URL": "https://foundry.example.com",
		},
	})

	if err := InjectClaudeSettings(9000); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	env := claudeEnvBlock(t)
	for _, key := range []string{"CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL"} {
		v, ok := env[key]
		if !ok {
			t.Fatalf("%s must remain present (empty) to override shell — not deleted", key)
		}
		if v != "" {
			t.Fatalf("%s should be neutralized to empty string, got %v", key, v)
		}
	}
}

// 取消接管必须把 Foundry 键还原成用户原值,不丢用户的 Foundry 配置。
func TestRestoreClaudeSettingsRestoresPriorFoundry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"env": map[string]interface{}{
			"CLAUDE_CODE_USE_FOUNDRY":    "1",
			"ANTHROPIC_FOUNDRY_RESOURCE": "my-resource",
		},
	})

	if err := InjectClaudeSettings(7777); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("RestoreClaudeSettings: %v", err)
	}
	env := claudeEnvBlock(t)
	if got := env["CLAUDE_CODE_USE_FOUNDRY"]; got != "1" {
		t.Fatalf("CLAUDE_CODE_USE_FOUNDRY not restored: %v", got)
	}
	if got := env["ANTHROPIC_FOUNDRY_RESOURCE"]; got != "my-resource" {
		t.Fatalf("ANTHROPIC_FOUNDRY_RESOURCE not restored: %v", got)
	}
	// 原本没有的 BASE_URL 还原后应保持缺失,不该凭空多出一个空串键。
	if _, ok := env["ANTHROPIC_FOUNDRY_BASE_URL"]; ok {
		t.Fatalf("ANTHROPIC_FOUNDRY_BASE_URL should stay absent (was not set before): %v", env)
	}
}

// 升级边界:老版本已接管(settings 里有 base/auth 注入 + 用户真实 API key),备份文件
// 是老格式(无 API key 字段)。新版再次注入必须补记真实 key 并置空;取消时还原回来,
// 不能丢钥。
func TestInjectCapturesApiKeyWhenBackupPredatesField(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	// settings.json:老版本注入留下的 base/auth + 用户真实 key(老版本没动它)。
	writeSeedSettings(t, dir, map[string]interface{}{
		"env": map[string]interface{}{
			"ANTHROPIC_BASE_URL":   "http://127.0.0.1:5000",
			"ANTHROPIC_AUTH_TOKEN": "bcai-claude-proxy",
			"ANTHROPIC_API_KEY":    "sk-user-real-key",
		},
	})
	// 老格式备份:只记了 base/auth,没有 API key 字段。
	oldBackup := `{"injected":true,"hadBaseUrl":false,"hadAuthToken":false}`
	if err := os.WriteFile(filepath.Join(dir, ".bcai-claude-backup.json"), []byte(oldBackup), 0o644); err != nil {
		t.Fatalf("seed backup: %v", err)
	}

	if err := InjectClaudeSettings(5000); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	if got := claudeEnvBlock(t)["ANTHROPIC_API_KEY"]; got != "" {
		t.Fatalf("api key should be neutralized, got %v", got)
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("RestoreClaudeSettings: %v", err)
	}
	if got := claudeEnvBlock(t)["ANTHROPIC_API_KEY"]; got != "sk-user-real-key" {
		t.Fatalf("real api key lost across upgrade-mid-takeover restore: %v", got)
	}
}

// 接管必须预置 ~/.claude.json 的 theme + hasCompletedOnboarding,否则 /logout 后
// claude 会弹首次 onboarding(Welcome/Security notes/Press Enter)挡住接管。
func readGlobalConfig(t *testing.T, dir string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, ".claude.json"))
	if err != nil {
		t.Fatalf("read .claude.json: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse .claude.json: %v", err)
	}
	return m
}

func TestInjectCompletesOnboardingInGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	// 模拟 /logout 后的状态:无 theme + hasCompletedOnboarding=false + 用户其它键。
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"),
		[]byte(`{"hasCompletedOnboarding":false,"someUserKey":"keep"}`), 0o600); err != nil {
		t.Fatalf("seed global config: %v", err)
	}

	if err := InjectClaudeSettings(9000); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	cfg := readGlobalConfig(t, dir)
	if cfg["theme"] != "dark" {
		t.Fatalf("theme not seeded: %v", cfg["theme"])
	}
	if cfg["hasCompletedOnboarding"] != true {
		t.Fatalf("hasCompletedOnboarding not set: %v", cfg["hasCompletedOnboarding"])
	}
	if cfg["someUserKey"] != "keep" {
		t.Fatalf("unrelated global config key lost: %v", cfg["someUserKey"])
	}
}

func TestInjectPreservesExistingTheme(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"),
		[]byte(`{"theme":"light","hasCompletedOnboarding":true}`), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := InjectClaudeSettings(9000); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	if got := readGlobalConfig(t, dir)["theme"]; got != "light" {
		t.Fatalf("existing theme overwritten: %v", got)
	}
}

func TestInjectDoesNotClobberMalformedGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	bad := `{ not valid json `
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(bad), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := InjectClaudeSettings(9000); err != nil {
		t.Fatalf("InjectClaudeSettings should not error: %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, ".claude.json"))
	if string(data) != bad {
		t.Fatalf("malformed global config must not be rewritten, got: %q", string(data))
	}
}

func TestRestoreClaudeSettingsRestoresPriorUserValue(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	// User already pointed Claude at their own gateway — restore must bring it back.
	writeSeedSettings(t, dir, map[string]interface{}{
		"env": map[string]interface{}{
			"ANTHROPIC_BASE_URL":   "https://my-own-gateway.example",
			"ANTHROPIC_AUTH_TOKEN": "user-token",
		},
	})

	if err := InjectClaudeSettings(7777); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	// Sanity: our value is in place while injected.
	if claudeEnvBlock(t)["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:7777" {
		t.Fatal("inject did not override the user base url")
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("RestoreClaudeSettings: %v", err)
	}

	env := claudeEnvBlock(t)
	if env["ANTHROPIC_BASE_URL"] != "https://my-own-gateway.example" {
		t.Fatalf("prior base url not restored: %v", env["ANTHROPIC_BASE_URL"])
	}
	if env["ANTHROPIC_AUTH_TOKEN"] != "user-token" {
		t.Fatalf("prior auth token not restored: %v", env["ANTHROPIC_AUTH_TOKEN"])
	}
}

func TestInjectClaudeSettingsIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"env": map[string]interface{}{"ANTHROPIC_BASE_URL": "https://orig.example", "ANTHROPIC_AUTH_TOKEN": "orig"},
	})

	if err := InjectClaudeSettings(7777); err != nil {
		t.Fatalf("inject 1: %v", err)
	}
	if err := InjectClaudeSettings(7777); err != nil {
		t.Fatalf("inject 2: %v", err)
	}
	// Double-inject must not clobber the backup with our own injected values.
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := claudeEnvBlock(t)["ANTHROPIC_BASE_URL"]; got != "https://orig.example" {
		t.Fatalf("idempotency broken — restore yielded %v, want https://orig.example", got)
	}
}

func writeSeedSettings(t *testing.T, dir string, settings map[string]interface{}) {
	t.Helper()
	data, _ := json.MarshalIndent(settings, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), data, 0o644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
}

// 完整注入(Claude Code)应连顶层 model 字段一起清掉,Restore 时原样写回。
func TestInjectClearsTopLevelModelAndRestores(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"model": "claude-opus-4-6-thinking",
		"env":   map[string]interface{}{"ANTHROPIC_MODEL": "claude-opus-4-6-thinking"},
	})

	if err := InjectClaudeSettings(9100); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	settings := readClaudeSettings(t)
	if _, ok := settings["model"]; ok {
		t.Fatalf("顶层 model 字段应被清掉,实际仍在: %v", settings["model"])
	}
	if env := claudeEnvBlock(t); env["ANTHROPIC_MODEL"] != nil {
		t.Fatalf("ANTHROPIC_MODEL 应被删除,实际: %v", env["ANTHROPIC_MODEL"])
	}

	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("RestoreClaudeSettings: %v", err)
	}
	settings = readClaudeSettings(t)
	if settings["model"] != "claude-opus-4-6-thinking" {
		t.Fatalf("还原后 model 字段应写回原值,实际: %v", settings["model"])
	}
	if env := claudeEnvBlock(t); env["ANTHROPIC_MODEL"] != "claude-opus-4-6-thinking" {
		t.Fatalf("还原后 ANTHROPIC_MODEL 应写回,实际: %v", env["ANTHROPIC_MODEL"])
	}
}

// 桌面端「只清模型」:删 model 字段 + 模型 env 键,但不注入 BASE_URL;保留无关 env;Restore 还原。
func TestCleanClaudeModelConfigClearsAndRestores(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{
		"model": "opus",
		"env":   map[string]interface{}{"ANTHROPIC_MODEL": "x", "MY_VAR": "keep"},
	})

	if err := CleanClaudeModelConfig(); err != nil {
		t.Fatalf("CleanClaudeModelConfig: %v", err)
	}
	settings := readClaudeSettings(t)
	if _, ok := settings["model"]; ok {
		t.Fatalf("model 字段应被清掉,实际: %v", settings["model"])
	}
	env := claudeEnvBlock(t)
	if env["ANTHROPIC_MODEL"] != nil {
		t.Fatalf("ANTHROPIC_MODEL 应被删除,实际: %v", env["ANTHROPIC_MODEL"])
	}
	if env["MY_VAR"] != "keep" {
		t.Fatalf("无关 env 应保留,实际: %v", env["MY_VAR"])
	}
	if env["ANTHROPIC_BASE_URL"] != nil {
		t.Fatalf("只清模型不应注入 BASE_URL,实际: %v", env["ANTHROPIC_BASE_URL"])
	}

	if err := RestoreClaudeModelConfig(); err != nil {
		t.Fatalf("RestoreClaudeModelConfig: %v", err)
	}
	settings = readClaudeSettings(t)
	if settings["model"] != "opus" {
		t.Fatalf("还原后 model 应写回,实际: %v", settings["model"])
	}
	if env := claudeEnvBlock(t); env["ANTHROPIC_MODEL"] != "x" {
		t.Fatalf("还原后 ANTHROPIC_MODEL 应写回,实际: %v", env["ANTHROPIC_MODEL"])
	}
	if _, err := os.Stat(claudeBackupPath()); !os.IsNotExist(err) {
		t.Fatalf("还原后备份文件应被删除")
	}
}

// 共存:桌面端只清模型 → Claude Code 完整注入 → 桌面端取消接管时应「跳过还原」保持清除态;
// 直到完整接管也取消,model 字段才回到原值。
func TestDesktopRestoreSkipsWhileFullInjectActive(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSeedSettings(t, dir, map[string]interface{}{"model": "opus"})

	if err := CleanClaudeModelConfig(); err != nil {
		t.Fatalf("CleanClaudeModelConfig: %v", err)
	}
	if err := InjectClaudeSettings(9200); err != nil {
		t.Fatalf("InjectClaudeSettings: %v", err)
	}
	// 桌面端取消接管:完整注入仍在用 → 应跳过,model 保持清除、BASE_URL 仍在。
	if err := RestoreClaudeModelConfig(); err != nil {
		t.Fatalf("RestoreClaudeModelConfig: %v", err)
	}
	settings := readClaudeSettings(t)
	if _, ok := settings["model"]; ok {
		t.Fatalf("完整接管仍生效时 model 应保持清除,实际: %v", settings["model"])
	}
	if env := claudeEnvBlock(t); env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:9200" {
		t.Fatalf("完整接管的 BASE_URL 不应被桌面端还原破坏,实际: %v", env["ANTHROPIC_BASE_URL"])
	}

	// 完整接管取消:此时才把 model 写回原值。
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatalf("RestoreClaudeSettings: %v", err)
	}
	settings = readClaudeSettings(t)
	if settings["model"] != "opus" {
		t.Fatalf("完整接管还原后 model 应回到原值,实际: %v", settings["model"])
	}
	if env, _ := settings["env"].(map[string]interface{}); env["ANTHROPIC_BASE_URL"] != nil {
		t.Fatalf("完整接管还原后 BASE_URL 应被移除,实际: %v", env["ANTHROPIC_BASE_URL"])
	}
}
