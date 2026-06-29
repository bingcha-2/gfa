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
	want := []string{
		filepath.Join(lad, "Programs", "Codex", "Codex.exe"),
		filepath.Join(pf, "Codex", "Codex.exe"),
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
	if len(got) != 1 || got[0] != filepath.Join("X", "Programs", "Codex", "Codex.exe") {
		t.Fatalf("只有 LOCALAPPDATA 时应只返回一个候选, got %v", got)
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
