package main

import (
	"os"
	"strings"
	"testing"
)

func TestVscodeWrapperScript(t *testing.T) {
	got := vscodeWrapperScript("/opt/homebrew/bin/sbx", "/kits/gfa")
	for _, want := range []string{
		`[ -f "$1" ] && shift`,                          // 条件 shift(内置路径「仅存在时」传入)
		`SBX="/opt/homebrew/bin/sbx"`,                   // 绝对 sbx 路径(GUI PATH 常无 brew)
		`KIT="/kits/gfa"`,                               // 绝对 kit 路径
		`gfa-vscode-$(printf %s "$PWD" | shasum`,             // per-workspace 命名
		`"$SBX" create --name "$NAME" --kit "$KIT" claude "$PWD"`, // 惰性建 box(不进入)
		`exec "$SBX" exec -i -w "$PWD" "$NAME" claude "$@"`,       // exec -i 干净 stdio 透传(非 sbx run)
		`--dangerously-skip-permissions`,                         // 沙箱内跳权限(权限确认过 exec 不弹面板)
		`--permission-prompt-tool`,                               // 冲突防护:SDK 自带 prompt-tool 时不注入
		"SBX_NO_TELEMETRY=1",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("wrapper missing %q\n---\n%s", want, got)
		}
	}
}

func TestVscodeFamilyEditors(t *testing.T) {
	eds := vscodeFamilyEditors()
	if len(eds) < 4 {
		t.Fatalf("expected VSCode family list, got %d", len(eds))
	}
	var names []string
	for _, e := range eds {
		if !strings.HasSuffix(e.SettingsPath, "settings.json") {
			t.Errorf("%s path should end with settings.json: %q", e.Name, e.SettingsPath)
		}
		names = append(names, e.Name)
	}
	joined := strings.Join(names, ",")
	for _, want := range []string{"VSCode", "Cursor", "Antigravity IDE"} {
		if !strings.Contains(joined, want) {
			t.Errorf("family should include %q; got %s", want, joined)
		}
	}
}

func TestVscodeTargetRegistered(t *testing.T) {
	tgt := findTakeoverTarget("claude_vscode_sandbox")
	if tgt == nil {
		t.Fatal("claude_vscode_sandbox not registered")
	}
	if tgt.InjectionType() != "vscode_sandbox" {
		t.Errorf("type=%q", tgt.InjectionType())
	}
	if got := targetRequiredProduct("claude_vscode_sandbox"); got != "anthropic" {
		t.Errorf("required product=%q want anthropic", got)
	}
}

func TestSetAndClearVscodeSetting(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/settings.json"
	// 空文件起步:注入后应含 wrapper 键
	if err := setVscodeWrapperSetting(path, "/w/x.sh"); err != nil {
		t.Fatalf("set: %v", err)
	}
	b, _ := readFileString(path)
	if !strings.Contains(b, "claudeCode.claudeProcessWrapper") || !strings.Contains(b, "/w/x.sh") {
		t.Errorf("setting not written: %s", b)
	}
	// 清除后应不含该键
	if err := clearVscodeWrapperSetting(path); err != nil {
		t.Fatalf("clear: %v", err)
	}
	b, _ = readFileString(path)
	if strings.Contains(b, "claudeCode.claudeProcessWrapper") {
		t.Errorf("setting not cleared: %s", b)
	}
}

func readFileString(p string) (string, error) {
	b, err := os.ReadFile(p)
	return string(b), err
}
