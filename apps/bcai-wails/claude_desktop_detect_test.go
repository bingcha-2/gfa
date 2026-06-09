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

// 复现 Windows 反馈:Claude 装在 Squirrel 版本化子目录 app-<ver>\claude.exe、
// 根目录没有 shim。此时纯文件系统检测应当也能找到它(关着也能检测到),
// 否则就只能靠「进程嗅探」—— 即 Claude 开着才显示,形成死循环。
func TestClaudeDesktop_SquirrelVersionedDir(t *testing.T) {
	la := t.TempDir()
	pf := t.TempDir()
	mkExe(t, filepath.Join(la, "AnthropicClaude", "app-0.13.0", "claude.exe"))

	got := claudeDesktopFromDirs(la, pf)
	if got == "" {
		t.Fatalf("Squirrel app-* 布局未被检测到(只有进程嗅探能救 → 关掉就消失的死循环)")
	}
}

// 根目录 shim 存在时也应命中(标准安装,作为对照)。
func TestClaudeDesktop_RootShim(t *testing.T) {
	la := t.TempDir()
	want := filepath.Join(la, "AnthropicClaude", "claude.exe")
	mkExe(t, want)
	if got := claudeDesktopFromDirs(la, ""); got != want {
		t.Fatalf("root shim 未命中: got %q want %q", got, want)
	}
}

// 复现 Windows「接管后登录不变 Max」:带代理重启 Claude 的 argv 必须包含 Chromium 的
// --proxy-server(否则登录态/订阅等级走的 Chromium 流量不进 MITM,patchSubscriptionTree
// 那条「升级成 Max」永远不执行)。v9.1.0 只设了 env、漏了这条 flag。
func TestClaudeDesktop_RelaunchArgvCarriesChromiumProxy(t *testing.T) {
	const addr = "127.0.0.1:48801"
	const exe = `C:\Users\dell\AppData\Local\AnthropicClaude\claude.exe`

	// CA 可信(chromiumProxy=true):必须带 --proxy-server,否则订阅等级掀不翻 Max。
	argv := claudeMitmRelaunchArgv(exe, addr, true)
	if len(argv) == 0 || argv[0] != exe {
		t.Fatalf("argv[0] 必须是可执行文件路径: %v", argv)
	}
	if !hasArg(argv, "--proxy-server="+addr) {
		t.Fatalf("CA 可信时 argv 缺少 --proxy-server=%s: %v", addr, argv)
	}
	if !hasArg(argv, "--proxy-bypass-list=127.0.0.1,localhost") {
		t.Fatalf("argv 缺少 --proxy-bypass-list(本机回环应放行): %v", argv)
	}
}

// 防白屏闸门:CA 不可信(chromiumProxy=false)时【绝不能】给 Chromium 加 --proxy-server,
// 否则 claude.ai 被 MITM 却信不过证书 → 桌面端整页白屏。此时只启动 exe(env 由调用方设)。
func TestClaudeDesktop_RelaunchArgvNoProxyWhenCAUntrusted(t *testing.T) {
	const exe = `C:\Users\dell\AppData\Local\AnthropicClaude\claude.exe`
	argv := claudeMitmRelaunchArgv(exe, "127.0.0.1:48801", false)
	if len(argv) != 1 || argv[0] != exe {
		t.Fatalf("CA 不可信时只应启动 exe、不带任何代理 flag(防白屏): %v", argv)
	}
	for _, a := range argv {
		if a != exe && (a == "--proxy-server=127.0.0.1:48801" || a == "--proxy-bypass-list=127.0.0.1,localhost") {
			t.Fatalf("CA 不可信仍带了 Chromium 代理 flag → 会白屏: %v", argv)
		}
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
