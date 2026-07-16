package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// withSkinHome 覆写 codexSkinHomeDir 到临时目录 —— 绝不读写真实 ~/.bingchaai。
func withSkinHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := codexSkinHomeDir
	codexSkinHomeDir = func() string { return dir }
	t.Cleanup(func() { codexSkinHomeDir = old })
	return dir
}

func TestCodexSkinStateRoundTrip(t *testing.T) {
	withSkinHome(t)

	// 未写过 → 视为未开启,端口回落默认。
	got := readCodexSkinState()
	if got.Enabled || got.Port != codexSkinChannelPort {
		t.Fatalf("缺省态应为未开启+默认端口,got %+v", got)
	}

	if err := writeCodexSkinState(true); err != nil {
		t.Fatalf("writeCodexSkinState(true): %v", err)
	}
	got = readCodexSkinState()
	if !got.Enabled || got.Port != codexSkinChannelPort {
		t.Fatalf("开启后应 enabled+默认端口,got %+v", got)
	}
	if _, err := time.Parse(time.RFC3339, got.UpdatedAt); err != nil {
		t.Fatalf("UpdatedAt 应为 RFC3339,got %q: %v", got.UpdatedAt, err)
	}

	if err := writeCodexSkinState(false); err != nil {
		t.Fatalf("writeCodexSkinState(false): %v", err)
	}
	if readCodexSkinState().Enabled {
		t.Fatal("关闭后应 enabled=false")
	}
}

func TestReadCodexSkinStateCorrupt(t *testing.T) {
	withSkinHome(t)
	if err := os.MkdirAll(codexSkinRootDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexSkinStatePath(), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := readCodexSkinState()
	if got.Enabled || got.Port != codexSkinChannelPort {
		t.Fatalf("损坏的 state.json 应回落未开启+默认端口,got %+v", got)
	}
}

func TestMaterializeCodexSkinSkill(t *testing.T) {
	withSkinHome(t)
	if err := materializeCodexSkinSkill(); err != nil {
		t.Fatalf("materializeCodexSkinSkill: %v", err)
	}

	// skill 两个文件齐且非空;themes/ 目录同步建好。
	for _, name := range []string{"SKILL.md", "inject.mjs"} {
		data, err := os.ReadFile(filepath.Join(codexSkinSkillDir(), name))
		if err != nil {
			t.Fatalf("读 %s: %v", name, err)
		}
		if len(data) == 0 {
			t.Fatalf("%s 不应为空", name)
		}
	}
	if fi, err := os.Stat(codexSkinThemesDir()); err != nil || !fi.IsDir() {
		t.Fatalf("themes/ 应为目录,err=%v", err)
	}

	// SKILL.md 中承诺的路径协议必须与实现一致(对外契约防漂移)。
	md, _ := os.ReadFile(filepath.Join(codexSkinSkillDir(), "SKILL.md"))
	for _, want := range []string{"~/.bingchaai/codex-skin/state.json", "inject.mjs", "--remove"} {
		if !strings.Contains(string(md), want) {
			t.Fatalf("SKILL.md 缺少对外契约片段 %q", want)
		}
	}

	// 重复落盘 = 覆盖修复:篡改后再 materialize 应还原。
	target := filepath.Join(codexSkinSkillDir(), "inject.mjs")
	if err := os.WriteFile(target, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := materializeCodexSkinSkill(); err != nil {
		t.Fatalf("re-materialize: %v", err)
	}
	data, _ := os.ReadFile(target)
	if string(data) == "tampered" {
		t.Fatal("re-materialize 应覆盖被篡改的 skill 文件")
	}
}

func TestProbeCodexSkinChannelAt(t *testing.T) {
	// 可达:本地起一个应答 /json/version 的假 CDP 端点。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	_, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	if !probeCodexSkinChannelAt(port) {
		t.Fatal("对在线端点探测应为 true")
	}

	// 不可达:关掉后同端口应探测失败。
	srv.Close()
	if probeCodexSkinChannelAt(port) {
		t.Fatal("对已关闭端点探测应为 false")
	}
}
