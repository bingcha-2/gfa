package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// isGFAOwnedRelayValue 是整个"竞争中转清理"的红线核心:凡指向本地代理(loopback)或
// 我们的哨兵 token 的值,一律判为"GFA 自己",绝不能被当成第三方中转清掉。
func TestIsGFAOwnedRelayValue(t *testing.T) {
	const port = 8317
	cases := []struct {
		name string
		val  string
		want bool
	}{
		{"local proxy exact", claudeProxyBaseURL(port), true},
		{"loopback other port", "http://127.0.0.1:9999", true},
		{"localhost", "http://localhost:1234", true},
		{"sentinel auth token", claudeSentinelAuthToken, true},
		{"third-party relay url", "https://api.other-relay.com", false},
		{"third-party token", "sk-other-xxxx", false},
		{"empty", "", false},
	}
	for _, c := range cases {
		if got := isGFAOwnedRelayValue(c.val, port); got != c.want {
			t.Errorf("%s: isGFAOwnedRelayValue(%q)=%v want %v", c.name, c.val, got, c.want)
		}
	}
}

// scanSettingsEnvConflicts 从 settings.json 的 env 块里挑出指向第三方中转的
// ANTHROPIC_BASE_URL —— GFA 自己的（loopback/哨兵）和缺省的都不算冲突。
func TestScanSettingsEnvConflicts(t *testing.T) {
	const port = 8317

	t.Run("flags third-party base url", func(t *testing.T) {
		env := map[string]interface{}{"ANTHROPIC_BASE_URL": "https://api.other-relay.com"}
		got := scanSettingsEnvConflicts(env, port)
		if len(got) != 1 {
			t.Fatalf("want 1 conflict, got %d: %+v", len(got), got)
		}
		if got[0].Kind != "settings-env" {
			t.Errorf("Kind=%q want settings-env", got[0].Kind)
		}
		if !strings.Contains(got[0].Detail, "other-relay") {
			t.Errorf("Detail=%q should include the relay url", got[0].Detail)
		}
		if !strings.Contains(got[0].Location, "settings.json") {
			t.Errorf("Location=%q should point at settings.json", got[0].Location)
		}
	})

	t.Run("ignores GFA own base url", func(t *testing.T) {
		env := map[string]interface{}{"ANTHROPIC_BASE_URL": claudeProxyBaseURL(port)}
		if got := scanSettingsEnvConflicts(env, port); len(got) != 0 {
			t.Errorf("GFA-owned base url must not be flagged, got %+v", got)
		}
	})

	t.Run("ignores absent base url", func(t *testing.T) {
		if got := scanSettingsEnvConflicts(map[string]interface{}{}, port); len(got) != 0 {
			t.Errorf("no base url should yield no conflict, got %+v", got)
		}
	})
}

// detectCcSwitch 检测机器上是否存在 cc-switch（第三方切换工具，封号重点点名对象）。
func TestDetectCcSwitch(t *testing.T) {
	t.Run("flags when .cc-switch dir present", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".cc-switch"), 0o755); err != nil {
			t.Fatal(err)
		}
		got := detectCcSwitch(home)
		if len(got) != 1 {
			t.Fatalf("want 1 conflict, got %d: %+v", len(got), got)
		}
		if got[0].Kind != "cc-switch" {
			t.Errorf("Kind=%q want cc-switch", got[0].Kind)
		}
		if !strings.Contains(got[0].Location, ".cc-switch") {
			t.Errorf("Location=%q should point at the .cc-switch dir", got[0].Location)
		}
	})

	t.Run("silent when absent", func(t *testing.T) {
		if got := detectCcSwitch(t.TempDir()); len(got) != 0 {
			t.Errorf("no .cc-switch dir should yield no conflict, got %+v", got)
		}
	})
}

// 同一 rc 文件里多条第三方 export 只应产出【一条】冲突（清理是整文件级的，
// 每行一条会导致同 ID 重复 → 编排器复检时把已清项误判为未清）。
func TestScanShellRCConflictsOnePerFile(t *testing.T) {
	const port = 8317
	rc := filepath.Join(t.TempDir(), ".zshrc")
	body := "export ANTHROPIC_BASE_URL=https://relay1.example\nexport ANTHROPIC_BASE_URL=https://relay2.example\n"
	if err := os.WriteFile(rc, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := scanShellRCConflicts(rc, port); len(got) != 1 {
		t.Fatalf("multiple third-party exports in one file should yield exactly 1 conflict, got %d: %+v", len(got), got)
	}
}

// detectCompetingClaudeConfig 是编排入口：读真实 settings.json + home，把各检测器结果合并。
func TestDetectCompetingClaudeConfig(t *testing.T) {
	const port = 8317
	home := t.TempDir()
	cfgDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := `{"env":{"ANTHROPIC_BASE_URL":"https://api.other-relay.com"}}`
	if err := os.WriteFile(filepath.Join(cfgDir, "settings.json"), []byte(settings), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".cc-switch"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)

	got := detectCompetingClaudeConfig(port)

	kinds := map[string]bool{}
	for _, c := range got {
		kinds[c.Kind] = true
	}
	if !kinds["settings-env"] {
		t.Errorf("should detect third-party base url in settings.json; got %+v", got)
	}
	if !kinds["cc-switch"] {
		t.Errorf("should detect cc-switch dir; got %+v", got)
	}
}

// scanShellRCConflicts 从单个 shell 启动脚本里挑出 export 的第三方中转地址。
func TestScanShellRCConflicts(t *testing.T) {
	const port = 8317

	t.Run("flags third-party export", func(t *testing.T) {
		rc := filepath.Join(t.TempDir(), ".zshrc")
		body := "# my rc\nexport ANTHROPIC_BASE_URL=https://api.other-relay.com\nalias ll='ls -la'\n"
		if err := os.WriteFile(rc, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		got := scanShellRCConflicts(rc, port)
		if len(got) != 1 {
			t.Fatalf("want 1 conflict, got %d: %+v", len(got), got)
		}
		if got[0].Kind != "shell-rc" {
			t.Errorf("Kind=%q want shell-rc", got[0].Kind)
		}
		if !strings.Contains(got[0].Location, ".zshrc") {
			t.Errorf("Location=%q should point at the rc file", got[0].Location)
		}
		if !strings.Contains(got[0].Detail, "other-relay") {
			t.Errorf("Detail=%q should include the relay url", got[0].Detail)
		}
	})

	t.Run("ignores quoted GFA loopback export", func(t *testing.T) {
		rc := filepath.Join(t.TempDir(), ".bashrc")
		if err := os.WriteFile(rc, []byte(`export ANTHROPIC_BASE_URL="http://127.0.0.1:8317"`+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := scanShellRCConflicts(rc, port); len(got) != 0 {
			t.Errorf("GFA loopback export must not be flagged, got %+v", got)
		}
	})

	t.Run("silent when file missing", func(t *testing.T) {
		if got := scanShellRCConflicts(filepath.Join(t.TempDir(), "nope"), port); len(got) != 0 {
			t.Errorf("missing rc file should yield no conflict, got %+v", got)
		}
	})
}

// backupFileTo 把源文件复制进备份目录（源不存在则静默）。
func TestBackupFileTo(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(src, []byte(`{"a":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	backupDir := filepath.Join(dir, "bk")

	if err := backupFileTo(backupDir, src); err != nil {
		t.Fatalf("backupFileTo err: %v", err)
	}
	// 备份目录里应存在一份与源同内容的拷贝
	entries, _ := os.ReadDir(backupDir)
	if len(entries) != 1 {
		t.Fatalf("want 1 backup file, got %d", len(entries))
	}
	got, _ := os.ReadFile(filepath.Join(backupDir, entries[0].Name()))
	if string(got) != `{"a":1}` {
		t.Errorf("backup content=%q want the original", got)
	}

	t.Run("missing source is no-op", func(t *testing.T) {
		if err := backupFileTo(backupDir, filepath.Join(dir, "nope")); err != nil {
			t.Errorf("missing source should be nil, got %v", err)
		}
	})
}

// sanitizeSettingsEnvBaseURL 从 settings.json 挖掉第三方 ANTHROPIC_BASE_URL，保留其它设置。
func TestSanitizeSettingsEnvBaseURL(t *testing.T) {
	const port = 8317

	t.Run("removes third-party base url, keeps rest", func(t *testing.T) {
		home := t.TempDir()
		cfgDir := filepath.Join(home, ".claude")
		if err := os.MkdirAll(cfgDir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := `{"env":{"ANTHROPIC_BASE_URL":"https://api.other-relay.com","KEEP":"yes"},"theme":"dark"}`
		if err := os.WriteFile(filepath.Join(cfgDir, "settings.json"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
		backupDir := filepath.Join(home, "bk")

		cleaned, err := sanitizeSettingsEnvBaseURL(port, backupDir)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if !cleaned {
			t.Fatalf("should report cleaned")
		}
		settings, _ := loadClaudeSettings()
		env, _ := settings["env"].(map[string]interface{})
		if _, still := env["ANTHROPIC_BASE_URL"]; still {
			t.Errorf("ANTHROPIC_BASE_URL should be removed")
		}
		if env["KEEP"] != "yes" {
			t.Errorf("other env keys must be preserved, got %+v", env)
		}
		if settings["theme"] != "dark" {
			t.Errorf("top-level settings must be preserved")
		}
		if entries, _ := os.ReadDir(backupDir); len(entries) == 0 {
			t.Errorf("original settings.json should be backed up")
		}
	})

	t.Run("leaves GFA own base url untouched", func(t *testing.T) {
		home := t.TempDir()
		cfgDir := filepath.Join(home, ".claude")
		if err := os.MkdirAll(cfgDir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317"}}`
		if err := os.WriteFile(filepath.Join(cfgDir, "settings.json"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)

		cleaned, err := sanitizeSettingsEnvBaseURL(port, filepath.Join(home, "bk"))
		if err != nil || cleaned {
			t.Errorf("GFA own base url must not be cleaned; cleaned=%v err=%v", cleaned, err)
		}
	})
}

// sanitizeShellRCFile 从 shell rc 删掉第三方 export 行，保留其余，原文件先备份。
func TestSanitizeShellRCFile(t *testing.T) {
	const port = 8317

	t.Run("removes third-party export, keeps others", func(t *testing.T) {
		dir := t.TempDir()
		rc := filepath.Join(dir, ".zshrc")
		body := "alias ll='ls -la'\nexport ANTHROPIC_BASE_URL=https://api.other-relay.com\nexport PATH=$PATH:/x\n"
		if err := os.WriteFile(rc, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		backupDir := filepath.Join(dir, "bk")

		cleaned, err := sanitizeShellRCFile(rc, port, backupDir)
		if err != nil || !cleaned {
			t.Fatalf("want cleaned, got cleaned=%v err=%v", cleaned, err)
		}
		out, _ := os.ReadFile(rc)
		if strings.Contains(string(out), "other-relay") {
			t.Errorf("third-party export should be gone, got:\n%s", out)
		}
		if !strings.Contains(string(out), "alias ll") || !strings.Contains(string(out), "export PATH") {
			t.Errorf("other lines must be preserved, got:\n%s", out)
		}
		if entries, _ := os.ReadDir(backupDir); len(entries) == 0 {
			t.Errorf("original rc should be backed up")
		}
	})

	t.Run("GFA loopback export is no-op", func(t *testing.T) {
		dir := t.TempDir()
		rc := filepath.Join(dir, ".bashrc")
		if err := os.WriteFile(rc, []byte("export ANTHROPIC_BASE_URL=http://127.0.0.1:8317\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if cleaned, err := sanitizeShellRCFile(rc, port, filepath.Join(dir, "bk")); cleaned || err != nil {
			t.Errorf("GFA loopback must not be cleaned; cleaned=%v err=%v", cleaned, err)
		}
	})

	t.Run("missing file is no-op", func(t *testing.T) {
		dir := t.TempDir()
		if cleaned, err := sanitizeShellRCFile(filepath.Join(dir, "nope"), port, filepath.Join(dir, "bk")); cleaned || err != nil {
			t.Errorf("missing file should be no-op; cleaned=%v err=%v", cleaned, err)
		}
	})

	t.Run("preserves original file mode", func(t *testing.T) {
		dir := t.TempDir()
		rc := filepath.Join(dir, ".zshrc")
		if err := os.WriteFile(rc, []byte("export ANTHROPIC_BASE_URL=https://api.other-relay.com\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := sanitizeShellRCFile(rc, port, filepath.Join(dir, "bk")); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(rc)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("rc file mode should stay 0600, got %o", info.Mode().Perm())
		}
	})
}

// moveCcSwitchDir 把 ~/.cc-switch 整个搬进备份目录（即备份即删除）。
func TestMoveCcSwitchDir(t *testing.T) {
	t.Run("moves dir into backup", func(t *testing.T) {
		home := t.TempDir()
		ccDir := filepath.Join(home, ".cc-switch")
		if err := os.MkdirAll(ccDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(ccDir, "cc-switch.db"), []byte("data"), 0o644); err != nil {
			t.Fatal(err)
		}
		backupDir := filepath.Join(home, "bk")

		cleaned, err := moveCcSwitchDir(home, backupDir)
		if err != nil || !cleaned {
			t.Fatalf("want cleaned, got cleaned=%v err=%v", cleaned, err)
		}
		if _, err := os.Stat(ccDir); !os.IsNotExist(err) {
			t.Errorf("~/.cc-switch should be gone after move")
		}
		if _, err := os.Stat(filepath.Join(backupDir, ".cc-switch", "cc-switch.db")); err != nil {
			t.Errorf("cc-switch data should be preserved in backup: %v", err)
		}
	})

	t.Run("absent dir is no-op", func(t *testing.T) {
		home := t.TempDir()
		if cleaned, err := moveCcSwitchDir(home, filepath.Join(home, "bk")); cleaned || err != nil {
			t.Errorf("absent .cc-switch should be no-op; cleaned=%v err=%v", cleaned, err)
		}
	})
}

// SanitizeCompetingClaudeConfig 编排：按 ID 清理并复检，产出报告。
func TestSanitizeCompetingClaudeConfig(t *testing.T) {
	const port = 8317
	home := t.TempDir()
	cfgDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"env":{"ANTHROPIC_BASE_URL":"https://api.other-relay.com"}}`
	if err := os.WriteFile(filepath.Join(cfgDir, "settings.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)

	rep, err := sanitizeCompetingClaudeConfig(nil, port) // nil = 清理全部检出
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(rep.Cleaned) != 1 || rep.Cleaned[0] != "settings-env:"+claudeBaseURLKey {
		t.Errorf("want settings-env cleaned, got %+v (skipped %+v)", rep.Cleaned, rep.Skipped)
	}
	// 复检：清理后应检不出任何冲突
	if got := detectCompetingClaudeConfig(port); len(got) != 0 {
		t.Errorf("after sanitize, detection should be empty, got %+v", got)
	}
}

// App 层 Wails 绑定：检测→清理→复检 端到端。
func TestAppDetectAndSanitizeCompetingClaudeConfig(t *testing.T) {
	home := t.TempDir()
	cfgDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"env":{"ANTHROPIC_BASE_URL":"https://api.other-relay.com"}}`
	if err := os.WriteFile(filepath.Join(cfgDir, "settings.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)

	app := &App{}

	got, err := app.DetectCompetingClaudeConfig()
	if err != nil {
		t.Fatalf("Detect err: %v", err)
	}
	if len(got) != 1 || got[0].Kind != "settings-env" {
		t.Fatalf("Detect should surface the third-party base url, got %+v", got)
	}

	rep, err := app.SanitizeCompetingClaudeConfig(nil)
	if err != nil {
		t.Fatalf("Sanitize err: %v", err)
	}
	if len(rep.Cleaned) != 1 {
		t.Errorf("want 1 cleaned, got %+v (skipped %+v)", rep.Cleaned, rep.Skipped)
	}

	after, _ := app.DetectCompetingClaudeConfig()
	if len(after) != 0 {
		t.Errorf("after sanitize, detection should be empty, got %+v", after)
	}
}

// parseRegQueryValue 从 `reg query` 输出里抽出某个值名的字符串值（Windows os-env 扫描用）。
func TestParseRegQueryValue(t *testing.T) {
	out := "\r\nHKEY_CURRENT_USER\\Environment\r\n    ANTHROPIC_BASE_URL    REG_SZ    https://api.other-relay.com\r\n\r\n"

	t.Run("extracts value", func(t *testing.T) {
		v, ok := parseRegQueryValue(out, "ANTHROPIC_BASE_URL")
		if !ok {
			t.Fatalf("want ok, got not found in %q", out)
		}
		if v != "https://api.other-relay.com" {
			t.Errorf("value=%q want the relay url", v)
		}
	})

	t.Run("not found", func(t *testing.T) {
		if _, ok := parseRegQueryValue("ERROR: The system was unable to find the specified registry key", "ANTHROPIC_BASE_URL"); ok {
			t.Errorf("missing value should report not found")
		}
	})
}

// detectManagedSettings 检测企业策略文件 managed-settings.json（最高优先级，会盖过接管）。
func TestDetectManagedSettings(t *testing.T) {
	t.Run("flags when present", func(t *testing.T) {
		p := filepath.Join(t.TempDir(), "managed-settings.json")
		if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		got := detectManagedSettings(p)
		if len(got) != 1 {
			t.Fatalf("want 1 conflict, got %d: %+v", len(got), got)
		}
		if got[0].Kind != "managed-settings" {
			t.Errorf("Kind=%q want managed-settings", got[0].Kind)
		}
		if got[0].Severity != "blocking" {
			t.Errorf("Severity=%q want blocking", got[0].Severity)
		}
	})

	t.Run("silent when absent", func(t *testing.T) {
		if got := detectManagedSettings(filepath.Join(t.TempDir(), "nope")); len(got) != 0 {
			t.Errorf("absent managed-settings should yield no conflict, got %+v", got)
		}
	})
}

// 编排器应把 home 下常见 shell rc 里的第三方 export 也纳入检测。
func TestDetectCompetingClaudeConfigScansShellRC(t *testing.T) {
	const port = 8317
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".zshrc"),
		[]byte("export ANTHROPIC_BASE_URL=https://api.other-relay.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude")) // 无 settings.json，隔离干扰

	got := detectCompetingClaudeConfig(port)
	found := false
	for _, c := range got {
		if c.Kind == "shell-rc" {
			found = true
		}
	}
	if !found {
		t.Errorf("should detect third-party export in ~/.zshrc; got %+v", got)
	}
}

// 白名单红线的端到端复验：GFA 自己的接管注入绝不能被标成冲突。
func TestDetectCompetingClaudeConfigIgnoresOwnInjection(t *testing.T) {
	const port = 8317
	home := t.TempDir()
	cfgDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317","ANTHROPIC_AUTH_TOKEN":"bcai-claude-proxy"}}`
	if err := os.WriteFile(filepath.Join(cfgDir, "settings.json"), []byte(settings), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)

	if got := detectCompetingClaudeConfig(port); len(got) != 0 {
		t.Errorf("GFA's own takeover injection must not be flagged, got %+v", got)
	}
}
