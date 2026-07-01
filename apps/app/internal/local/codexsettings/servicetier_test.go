package codexsettings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return string(b)
}

// fast → config.toml 写 [desktop].default-service-tier="priority"(对齐 cockpit codex_speed)。
func TestSaveServiceTier_FastWritesDesktopTier(t *testing.T) {
	dir := t.TempDir()
	if err := SaveServiceTier(dir, true); err != nil {
		t.Fatalf("SaveServiceTier fast: %v", err)
	}
	toml := readFile(t, filepath.Join(dir, "config.toml"))
	if !strings.Contains(toml, "[desktop]") || !strings.Contains(toml, `default-service-tier = "priority"`) {
		t.Fatalf("config.toml 缺 [desktop].default-service-tier:\n%s", toml)
	}
	// 全局原子态也要写,避免 GUI 启动用持久化原子态把 config.toml 改回去。
	var st map[string]any
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(dir, ".codex-global-state.json"))), &st); err != nil {
		t.Fatalf("global-state 不是合法 JSON: %v", err)
	}
	atoms, _ := st["electron-persisted-atom-state"].(map[string]any)
	if atoms == nil || atoms["default-service-tier"] != "priority" || atoms["has-user-changed-service-tier"] != true {
		t.Fatalf("全局原子态未同步 priority/has-user-changed: %+v", atoms)
	}
}

// standard → 删除 config.toml 的 default-service-tier,但保留其它键/表结构。
func TestSaveServiceTier_StandardRemovesKeyKeepsRest(t *testing.T) {
	dir := t.TempDir()
	seed := "model_context_window = 1000000\n\n[desktop]\ndefault-service-tier = \"priority\"\nother = \"keep\"\n"
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveServiceTier(dir, false); err != nil {
		t.Fatalf("SaveServiceTier standard: %v", err)
	}
	toml := readFile(t, filepath.Join(dir, "config.toml"))
	if strings.Contains(toml, "default-service-tier") {
		t.Fatalf("standard 应删除 default-service-tier:\n%s", toml)
	}
	if !strings.Contains(toml, "model_context_window = 1000000") || !strings.Contains(toml, `other = "keep"`) {
		t.Fatalf("不该误伤其它键:\n%s", toml)
	}
}

// fast 时已存在 [desktop] 表则原地补键,不重复建表。
func TestSaveServiceTier_FastUpsertsIntoExistingDesktopTable(t *testing.T) {
	dir := t.TempDir()
	seed := "[desktop]\nfoo = \"bar\"\n"
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveServiceTier(dir, true); err != nil {
		t.Fatalf("SaveServiceTier: %v", err)
	}
	toml := readFile(t, filepath.Join(dir, "config.toml"))
	if strings.Count(toml, "[desktop]") != 1 {
		t.Fatalf("不应重复建 [desktop] 表:\n%s", toml)
	}
	if !strings.Contains(toml, `foo = "bar"`) || !strings.Contains(toml, `default-service-tier = "priority"`) {
		t.Fatalf("应保留 foo 并补 tier:\n%s", toml)
	}
}

// standard + 空配置:不创建 config.toml(无键可删),但仍同步全局原子态。
func TestSaveServiceTier_StandardEmptyNoConfigFile(t *testing.T) {
	dir := t.TempDir()
	if err := SaveServiceTier(dir, false); err != nil {
		t.Fatalf("SaveServiceTier: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("空配置 + standard 不应创建 config.toml")
	}
	if readFile(t, filepath.Join(dir, ".codex-global-state.json")) == "" {
		t.Fatalf("仍应同步全局原子态")
	}
}
