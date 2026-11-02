package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Legacy restore support only. New settings and sandbox creation are removed.
func clearEditorLoginGate() {
	if appActionsSuppressed() || runtime.GOOS != "darwin" {
		return
	}
	token, _ := exec.Command("launchctl", "getenv", "ANTHROPIC_AUTH_TOKEN").Output()
	if strings.TrimSpace(string(token)) != "bcai-claude-proxy" {
		return
	}
	_ = exec.Command("launchctl", "unsetenv", "ANTHROPIC_AUTH_TOKEN").Run()
	base, _ := exec.Command("launchctl", "getenv", "ANTHROPIC_BASE_URL").Output()
	if isGFAOwnedRelayValue(strings.TrimSpace(string(base)), 0) {
		_ = exec.Command("launchctl", "unsetenv", "ANTHROPIC_BASE_URL").Run()
	}

}

func vscodeWrapperPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".bcai", "claude-in-sbx.sh")
}

var vscodeFamilyDirs = []struct{ Name, Dir string }{
	{"VSCode", "Code"},
	{"VSCode Insiders", "Code - Insiders"},
	{"Cursor", "Cursor"},
	{"Antigravity IDE", "Antigravity IDE"},
	{"VSCodium", "VSCodium"},
	{"Windsurf", "Windsurf"},
}

func vscodeConfigBase() string {
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support")
	case "windows":
		return os.Getenv("APPDATA")
	default: // linux
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config")
	}
}

type vscodeEditor struct {
	Name         string
	SettingsPath string
}

func vscodeFamilyEditors() []vscodeEditor {
	base := vscodeConfigBase()
	out := make([]vscodeEditor, 0, len(vscodeFamilyDirs))
	for _, e := range vscodeFamilyDirs {
		out = append(out, vscodeEditor{Name: e.Name, SettingsPath: filepath.Join(base, e.Dir, "User", "settings.json")})
	}
	return out
}

func detectedVscodeEditors() []vscodeEditor {
	var out []vscodeEditor
	for _, e := range vscodeFamilyEditors() {
		if _, err := os.Stat(filepath.Dir(e.SettingsPath)); err == nil {
			out = append(out, e)
		}
	}
	return out
}

const vscodeWrapperSettingKey = "claudeCode.claudeProcessWrapper"

func clearVscodeWrapperSetting(path string) error {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var doc map[string]json.RawMessage
	if err = json.Unmarshal(b, &doc); err != nil {
		if strings.Contains(string(b), "claude-in-sbx.sh") {
			return fmt.Errorf("请从 %s 移除旧 claudeProcessWrapper: %w", path, err)
		}
		return nil
	}
	var wrapper string
	if json.Unmarshal(doc[vscodeWrapperSettingKey], &wrapper) != nil || wrapper != vscodeWrapperPath() {
		return nil
	}
	delete(doc, vscodeWrapperSettingKey)
	return writeDesktopJSON(path, doc)
}
