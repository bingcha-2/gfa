package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// detectCodexInVersionedBin 必须从 bin\<hash>\codex.exe 里找出 exe;直查 bin\codex.exe 命中
// 不到的新版 CLI 布局正是它要兜底的场景(见 detectCodexAppPath 的 windows 分支)。
func TestDetectCodexInVersionedBin(t *testing.T) {
	localAppData := t.TempDir()
	binDir := filepath.Join(localAppData, "OpenAI", "Codex", "bin")

	// 旧版哈希目录:只有 rg.exe,没有 codex.exe → 必须被跳过。
	oldDir := filepath.Join(binDir, "aaaa000000000000")
	if err := os.MkdirAll(oldDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(oldDir, "rg.exe"), "rg")

	// 当前版本哈希目录:有 codex.exe → 应当被选中。
	newDir := filepath.Join(binDir, "bbbb111111111111")
	if err := os.MkdirAll(newDir, 0o755); err != nil {
		t.Fatal(err)
	}
	wantExe := filepath.Join(newDir, "codex.exe")
	writeFile(t, wantExe, "codex")

	got := detectCodexInVersionedBin(localAppData)
	if got != wantExe {
		t.Fatalf("detectCodexInVersionedBin = %q, want %q", got, wantExe)
	}
}

// 多个哈希目录都含 codex.exe 时,取修改时间最新的那个(当前版本)。
func TestDetectCodexInVersionedBinPicksNewest(t *testing.T) {
	localAppData := t.TempDir()
	binDir := filepath.Join(localAppData, "OpenAI", "Codex", "bin")

	older := filepath.Join(binDir, "older000000000000", "codex.exe")
	newer := filepath.Join(binDir, "newer000000000000", "codex.exe")
	if err := os.MkdirAll(filepath.Dir(older), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(newer), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, older, "old")
	writeFile(t, newer, "new")
	// 把 older 的 mtime 调到过去,确保 newer 更新。
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(older, past, past); err != nil {
		t.Fatal(err)
	}

	if got := detectCodexInVersionedBin(localAppData); got != newer {
		t.Fatalf("detectCodexInVersionedBin = %q, want newest %q", got, newer)
	}
}

// 没有 bin 目录 / 空 localAppData → 返回空串,不 panic。
func TestDetectCodexInVersionedBinAbsent(t *testing.T) {
	if got := detectCodexInVersionedBin(""); got != "" {
		t.Fatalf("empty localAppData should yield \"\", got %q", got)
	}
	if got := detectCodexInVersionedBin(t.TempDir()); got != "" {
		t.Fatalf("missing bin dir should yield \"\", got %q", got)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
