package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func readSettings(t *testing.T, dir string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	m := map[string]interface{}{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse settings: %v", err)
	}
	return m
}

func writeSettings(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func envOf(m map[string]interface{}) map[string]interface{} {
	e, _ := m["env"].(map[string]interface{})
	return e
}

const testGatewayURL = "https://api.example.test/api/gateway"

func TestGatewayPatchKeepsUserConfigAndRestoresOnlyOurKeys(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSettings(t, dir, `{
  "hooks": {"PreToolUse": [{"matcher": "Bash"}]},
  "permissions": {"allow": ["Bash(ls)"]},
  "model": "claude-3-legacy",
  "env": {"ANTHROPIC_BASE_URL": "https://other-relay.example", "KEEP_ME": "yes", "ANTHROPIC_MODEL": "claude-3-legacy"}
}`)

	if err := InjectClaudeGateway(testGatewayURL, "gfa-abc123", []string{"claude-sonnet-4-6"}); err != nil {
		t.Fatal(err)
	}
	got := readSettings(t, dir)
	env := envOf(got)
	if env["ANTHROPIC_BASE_URL"] != testGatewayURL || env["ANTHROPIC_AUTH_TOKEN"] != "gfa-abc123" {
		t.Fatalf("gateway keys not written: %v", env)
	}
	if env["ANTHROPIC_API_KEY"] != "" {
		t.Fatalf("API_KEY must be blanked, got %v", env["ANTHROPIC_API_KEY"])
	}
	if env["KEEP_ME"] != "yes" {
		t.Fatalf("unrelated env var lost: %v", env)
	}
	if got["hooks"] == nil || got["permissions"] == nil {
		t.Fatalf("hooks/permissions must survive hosting: %v", got)
	}
	if _, ok := env["ANTHROPIC_MODEL"]; ok {
		t.Fatalf("unsupported model override must be removed")
	}
	if _, ok := got["model"]; ok {
		t.Fatalf("unsupported top-level model must be removed")
	}

	if err := RestoreClaudeSettings(); err != nil {
		t.Fatal(err)
	}
	back := readSettings(t, dir)
	benv := envOf(back)
	if benv["ANTHROPIC_BASE_URL"] != "https://other-relay.example" {
		t.Fatalf("original BASE_URL not restored: %v", benv)
	}
	if _, ok := benv["ANTHROPIC_AUTH_TOKEN"]; ok {
		t.Fatalf("our token must be gone: %v", benv)
	}
	if benv["ANTHROPIC_MODEL"] != "claude-3-legacy" || back["model"] != "claude-3-legacy" {
		t.Fatalf("model overrides not restored: env=%v model=%v", benv, back["model"])
	}
	if benv["KEEP_ME"] != "yes" || back["hooks"] == nil || back["permissions"] == nil {
		t.Fatalf("user config damaged by restore: %v", back)
	}
	if _, err := os.Stat(claudeBackupPath()); !os.IsNotExist(err) {
		t.Fatalf("backup should be removed after restore")
	}
}

func TestGatewayRestoreKeepsValuesUserChangedWhileHosted(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSettings(t, dir, `{"env": {"ANTHROPIC_BASE_URL": "https://old.example"}}`)

	if err := InjectClaudeGateway(testGatewayURL, "gfa-abc123", nil); err != nil {
		t.Fatal(err)
	}
	// 用户托管期间把地址改成了别的。
	m := readSettings(t, dir)
	envOf(m)["ANTHROPIC_BASE_URL"] = "https://user-new.example"
	b, _ := json.Marshal(m)
	writeSettings(t, dir, string(b))

	if err := RestoreClaudeSettings(); err != nil {
		t.Fatal(err)
	}
	if got := envOf(readSettings(t, dir))["ANTHROPIC_BASE_URL"]; got != "https://user-new.example" {
		t.Fatalf("user's own change must not be overwritten, got %v", got)
	}
}

func TestGatewayRepeatActivationKeepsTrueOriginal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSettings(t, dir, `{"env": {"ANTHROPIC_BASE_URL": "https://old.example"}}`)

	for _, key := range []string{"gfa-first", "gfa-second"} { // 换 key 重新托管
		if err := InjectClaudeGateway(testGatewayURL, key, nil); err != nil {
			t.Fatal(err)
		}
	}
	if got := envOf(readSettings(t, dir))["ANTHROPIC_AUTH_TOKEN"]; got != "gfa-second" {
		t.Fatalf("token not refreshed: %v", got)
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatal(err)
	}
	if got := envOf(readSettings(t, dir))["ANTHROPIC_BASE_URL"]; got != "https://old.example" {
		t.Fatalf("second activation must not capture our own value as original, got %v", got)
	}
}

func TestGatewayRemovesFileWhenNoneExistedBefore(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)

	if err := InjectClaudeGateway(testGatewayURL, "gfa-abc123", nil); err != nil {
		t.Fatal(err)
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("settings.json created by us should be removed when empty")
	}
}

func TestGatewayRefusesToOverwriteInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSettings(t, dir, `{ this is not json`)

	if err := InjectClaudeGateway(testGatewayURL, "gfa-abc123", nil); err == nil {
		t.Fatal("expected an error for invalid JSON settings")
	}
	data, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if string(data) != `{ this is not json` {
		t.Fatalf("invalid file must be left untouched, got %q", data)
	}
}

func TestModelAllowedKeepsAliasesAndSupportedIDs(t *testing.T) {
	allowed := map[string]bool{"claude-sonnet-4-6": true}
	cases := map[string]bool{
		"":                      true,
		"sonnet":                true,
		"opus[1m]":              true,
		"claude-sonnet-4-6":     true,
		"claude-sonnet-4-6[1m]": true,
		"claude-3-legacy":       false,
	}
	for m, want := range cases {
		if got := modelAllowed(m, allowed); got != want {
			t.Errorf("modelAllowed(%q)=%v want %v", m, got, want)
		}
	}
}

func TestGatewaySettingsFileIsOwnerOnly(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("POSIX permission bits are not meaningful on Windows")
	}
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := InjectClaudeGateway(testGatewayURL, "gfa-abc123", nil); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "settings.json"), claudeBackupPath()} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s perm=%o want 600", p, info.Mode().Perm())
		}
	}
}
