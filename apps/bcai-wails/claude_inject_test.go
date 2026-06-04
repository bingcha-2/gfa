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
