package main

import (
	"os"
	"path/filepath"
	"testing"
)

func mkExe(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("MZ"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func hasArg(argv []string, want string) bool {
	for _, a := range argv {
		if a == want {
			return true
		}
	}
	return false
}

// Store(MSIX)版接管前置识别:WindowsApps 下的路径必须判为商店版 → 接管入口据此拒绝并引导
// 换装独立安装器版,而非硬 exec 撞 Access is denied(见 takeover.go claudeDesktopTarget.Inject)。
func TestIsMicrosoftStoreClaude(t *testing.T) {
	store := []string{
		`C:\Program Files\WindowsApps\Claude_1.8555.2.0_x64__pzs8sxrjxfjjc\app\Claude.exe`,
		`C:\Program Files\windowsapps\Claude_x\app\claude.exe`, // 大小写不敏感
		`D:/Program Files/WindowsApps/Claude_y/app/Claude.exe`, // 正斜杠也认
	}
	for _, p := range store {
		if !isMicrosoftStoreClaude(p) {
			t.Errorf("应判为 Store(MSIX)版: %s", p)
		}
	}
	notStore := []string{
		`C:\Users\dell\AppData\Local\AnthropicClaude\claude.exe`,         // Squirrel
		`C:\Users\dell\AppData\Local\AnthropicClaude\app-0.1\claude.exe`, // Squirrel 版本子目录
		`/Applications/Claude.app/Contents/MacOS/Claude`,                 // macOS
		``,
	}
	for _, p := range notStore {
		if isMicrosoftStoreClaude(p) {
			t.Errorf("不应判为 Store 版: %q", p)
		}
	}
}

func TestClaudeDesktop_SquirrelVersionedDir(t *testing.T) {
	la := t.TempDir()
	pf := t.TempDir()
	mkExe(t, filepath.Join(la, "AnthropicClaude", "app-0.13.0", "claude.exe"))

	got := claudeDesktopFromDirs(la, pf)
	if got == "" {
		t.Fatalf("Squirrel app-* 布局未被检测到(只有进程嗅探能救 → 关掉就消失的死循环)")
	}
}

func TestClaudeDesktop_RootShim(t *testing.T) {
	la := t.TempDir()
	want := filepath.Join(la, "AnthropicClaude", "claude.exe")
	mkExe(t, want)
	if got := claudeDesktopFromDirs(la, ""); got != want {
		t.Fatalf("root shim 未命中: got %q want %q", got, want)
	}
}
