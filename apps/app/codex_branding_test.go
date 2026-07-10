package main

import (
	"path/filepath"
	"testing"
)

// codexBrandFromAppPath 必须能从 mac bundle 路径里抽出真实品牌名(兼容改名前后),
// 且对非 .app 路径(CLI / 空)安全返回空。
func TestCodexBrandFromAppPath(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"/Applications/Codex.app/Contents/Resources/codex", "Codex"},
		{"/Applications/ChatGPT.app/Contents/Resources/codex", "ChatGPT"},
		{"/Applications/ChatGPT.app", "ChatGPT"},
		{filepath.Join("/Users", "u", "Applications", "Codex.app", "Contents", "MacOS", "Codex"), "Codex"},
		{"/opt/Codex/codex", ""}, // 非 .app(linux)
		{"/usr/local/bin/codex", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := codexBrandFromAppPath(c.in); got != c.want {
			t.Errorf("codexBrandFromAppPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 进程/退出模式必须随品牌变化,且始终生成合法(非空、含 .app)的匹配串。
// go test 下 codexDesktopBrand 回落 "Codex",保证确定性。
func TestCodexProcessPatternsUseBrand(t *testing.T) {
	if got := codexDesktopBrand(); got != "Codex" {
		t.Fatalf("go test 下 codexDesktopBrand() 应回落 Codex, got %q", got)
	}
	if got, want := codexProcessTreePattern(), "Codex.app/Contents"; got != want {
		t.Errorf("codexProcessTreePattern() = %q, want %q", got, want)
	}
	if got, want := codexGUIMainPattern(), "Codex.app/Contents/MacOS/Codex"; got != want {
		t.Errorf("codexGUIMainPattern() = %q, want %q", got, want)
	}
	if got, want := codexWindowsImageName(), "Codex.exe"; got != want {
		t.Errorf("codexWindowsImageName() = %q, want %q", got, want)
	}
}

// codexBrandNames 至少覆盖旧名 Codex 与新名 ChatGPT。
func TestCodexBrandNamesCoverRename(t *testing.T) {
	names := codexBrandNames()
	has := map[string]bool{}
	for _, n := range names {
		has[n] = true
	}
	for _, need := range []string{"Codex", "ChatGPT"} {
		if !has[need] {
			t.Errorf("codexBrandNames() 缺少 %q: %v", need, names)
		}
	}
}
