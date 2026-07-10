package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// detectCodexOnPath 是纯 CLI 安装(npm -g / brew / 软链)的兜底探测:在 PATH 里找 `codex`。
// 没有它,这类安装会漏检,接管按钮不出现。
func TestDetectCodexOnPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 下 LookPath 走 PATHEXT/.exe 语义,另行手测")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	if got := detectCodexOnPath(); got != bin {
		t.Fatalf("detectCodexOnPath = %q, want %q", got, bin)
	}
}

// PATH 上没有 codex 时返回空串,不报错。
func TestDetectCodexOnPathAbsent(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // 空目录,无 codex
	if got := detectCodexOnPath(); got != "" {
		t.Fatalf("PATH 无 codex 时应返回 \"\",得到 %q", got)
	}
}

// codexWindowsGUIExeCandidates 是 codexGUIInstalled 的 Windows 分支抽出的纯函数:
// 给定目录根,产出 GUI 候选可执行文件路径。跨平台可测(filepath.Join 在测试与实现里一致)。
func TestCodexWindowsGUIExeCandidates(t *testing.T) {
	lad := filepath.Join("C:", "Users", "u", "AppData", "Local")
	pf := filepath.Join("C:", "Program Files")

	got := codexWindowsGUIExeCandidates(lad, pf)
	// 改名兼容:每个根目录下都列出全部候选品牌(Codex + ChatGPT + …)。
	// Squirrel 布局(Slack/VSCode/Discord 同款):%LOCALAPPDATA%\<brand>\<brand>.exe,无 Programs 这层。
	want := []string{}
	for _, name := range codexBrandNames() {
		want = append(want, filepath.Join(lad, "Programs", name, name+".exe"))
	}
	for _, name := range codexBrandNames() {
		want = append(want, filepath.Join(lad, name, name+".exe"))
	}
	for _, name := range codexBrandNames() {
		want = append(want, filepath.Join(pf, name, name+".exe"))
	}
	if len(got) != len(want) {
		t.Fatalf("候选数量 = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("候选[%d] = %q, want %q", i, got[i], want[i])
		}
	}

	// 关键属性:绝不能把 CLI 的 OpenAI\Codex\bin 当成 GUI 安装(否则纯 CLI 误判成 GUI)。
	cliBinMarker := filepath.Join("OpenAI", "Codex", "bin")
	for _, p := range got {
		if strings.Contains(p, cliBinMarker) {
			t.Errorf("GUI 候选不应包含 CLI 的 bin 路径: %q", p)
		}
	}
}

// 空根目录被跳过:既不 panic,也不产出相对路径候选。
func TestCodexWindowsGUIExeCandidatesEmptyRoots(t *testing.T) {
	if got := codexWindowsGUIExeCandidates("", ""); len(got) != 0 {
		t.Fatalf("空根目录应返回空候选, got %v", got)
	}
	got := codexWindowsGUIExeCandidates("X", "")
	want := []string{}
	for _, name := range codexBrandNames() {
		want = append(want, filepath.Join("X", "Programs", name, name+".exe"))
	}
	for _, name := range codexBrandNames() {
		want = append(want, filepath.Join("X", name, name+".exe"))
	}
	if len(got) != len(want) {
		t.Fatalf("只有 LOCALAPPDATA 时应返回 %d 个候选, got %v", len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("候选[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// codexWindowsGUIOverride:手动指定的桌面端 exe 只要存在就认(改名/非标准名也放行),
// 但排除 CLI 二进制 codex.exe(归 CLI 判定,别当 GUI 触发 kill/relaunch)。
// 修的正是"用户手选了改名后的桌面端 exe,却因名字不是 Codex.exe/ChatGPT.exe 被拒"。
func TestCodexWindowsGUIOverride(t *testing.T) {
	dir := t.TempDir()

	// 改名的桌面端 exe(既非 Codex.exe 也非 ChatGPT.exe)→ 存在即接受。
	renamed := filepath.Join(dir, "OpenAI Codex.exe")
	writeFile(t, renamed, "gui")
	if got := codexWindowsGUIOverride(renamed); got != renamed {
		t.Fatalf("改名后的桌面端 exe 应被接受, got %q", got)
	}

	// CLI 二进制 codex.exe → 拒绝(不当 GUI)。
	cli := filepath.Join(dir, "codex.exe")
	writeFile(t, cli, "cli")
	if got := codexWindowsGUIOverride(cli); got != "" {
		t.Fatalf("codex.exe 是 CLI,不应当作 GUI override, got %q", got)
	}

	// 不存在的路径 / 非 .exe → 拒绝。
	if got := codexWindowsGUIOverride(filepath.Join(dir, "Nope.exe")); got != "" {
		t.Fatalf("不存在的 exe 应拒绝, got %q", got)
	}
	notExe := filepath.Join(dir, "ChatGPT.app")
	writeFile(t, notExe, "x")
	if got := codexWindowsGUIOverride(notExe); got != "" {
		t.Fatalf("非 .exe 应拒绝, got %q", got)
	}

	// 目录(哪怕叫 X.exe)→ 拒绝。
	exeDir := filepath.Join(dir, "Dir.exe")
	if err := os.MkdirAll(exeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := codexWindowsGUIOverride(exeDir); got != "" {
		t.Fatalf("目录不应被接受, got %q", got)
	}
}

// 入口改成"ChatGPT 桌面 App 优先"后,用户手填的纯 CLI 路径(非 .app 的存在文件)仍必须最优先——
// 不能被 GUI 自动探测盖过。这是接管的手动兜底,不容回归。
func TestDetectCodexAppPath_ExplicitCLIOverrideWins(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // 隔离 getAppDataDir → 临时 config
	cli := filepath.Join(t.TempDir(), "codex")
	writeFile(t, cli, "#!/bin/sh\n")
	if err := SaveConfig(Config{CodexAppPath: cli}); err != nil {
		t.Fatal(err)
	}
	if got := detectCodexAppPath(); got != cli {
		t.Fatalf("手填 CLI override 应最优先(不被 GUI 自动探测盖过), got %q want %q", got, cli)
	}
}

// codexConfiguredCLIOverride:只兜住"非 .app 的存在文件"这类手填 CLI 路径;.app / 空 / 不存在都返回空
// (.app override 交给 detectCodexGUIPath 自己校验)。
func TestCodexConfiguredCLIOverride(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cli := filepath.Join(t.TempDir(), "codex")
	writeFile(t, cli, "x")

	if err := SaveConfig(Config{CodexAppPath: cli}); err != nil {
		t.Fatal(err)
	}
	if got := codexConfiguredCLIOverride(); got != cli {
		t.Fatalf("手填 CLI 文件应命中, got %q", got)
	}

	// .app override → 不在此处理(留给 GUI 校验)。
	if err := SaveConfig(Config{CodexAppPath: filepath.Join(t.TempDir(), "ChatGPT.app")}); err != nil {
		t.Fatal(err)
	}
	if got := codexConfiguredCLIOverride(); got != "" {
		t.Fatalf(".app override 不应被 CLI 守卫兜住, got %q", got)
	}

	// 未配置 → 空。
	if err := SaveConfig(Config{}); err != nil {
		t.Fatal(err)
	}
	if got := codexConfiguredCLIOverride(); got != "" {
		t.Fatalf("未配置时应返回空, got %q", got)
	}
}

func TestDetectCodexCLIInAppBundle(t *testing.T) {
	app := filepath.Join(t.TempDir(), "Codex.app")
	cli := filepath.Join(app, "Contents", "Resources", "codex")
	if err := os.MkdirAll(filepath.Dir(cli), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if got := detectCodexCLIInAppBundle(app); got != cli {
		t.Fatalf("detectCodexCLIInAppBundle = %q, want %q", got, cli)
	}
}
