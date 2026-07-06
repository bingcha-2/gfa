package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateKitWritesFiles(t *testing.T) {
	dir := t.TempDir()
	o := defaultKitOptions(48800)
	if err := generateKitInto(dir, o); err != nil {
		t.Fatalf("generateKitInto: %v", err)
	}
	spec, err := os.ReadFile(filepath.Join(dir, "spec.yaml"))
	if err != nil {
		t.Fatalf("read spec.yaml: %v", err)
	}
	for _, want := range []string{"kind: mixin", "ANTHROPIC_BASE_URL: http://host.docker.internal:48800", `allow: [ "localhost:48800" ]`} {
		if !strings.Contains(string(spec), want) {
			t.Errorf("spec.yaml missing %q:\n%s", want, spec)
		}
	}
}

func TestApplyPolicySuppressed(t *testing.T) {
	// go test 里 appActionsSuppressed()==true,ApplyPolicy 必须短路返回 nil,不 exec 真 sbx。
	if err := ApplyPolicy(48800); err != nil {
		t.Errorf("ApplyPolicy under test should no-op, got %v", err)
	}
}

func TestInstallSbxCommandStringCurrent(t *testing.T) {
	// 当前平台应有安装命令(darwin/windows/linux 之一),不为空。
	if currentInstallCommandString() == "" {
		t.Error("currentInstallCommandString empty on supported platform")
	}
}

func TestInstallSbxSuppressed(t *testing.T) {
	// 抑制态(go test)不真开终端,短路返回 nil。
	if err := InstallSbx(); err != nil {
		t.Errorf("InstallSbx under test should no-op, got %v", err)
	}
}

func TestDetectSbxSuppressed(t *testing.T) {
	// 抑制态返回未装,不 exec sbx。
	if st := DetectSbx(); st.Installed {
		t.Errorf("DetectSbx under test should report not installed, got %+v", st)
	}
}

func TestClaudeSandboxTargetRegistered(t *testing.T) {
	tgt := findTakeoverTarget("claude_sandbox")
	if tgt == nil {
		t.Fatal("claude_sandbox target not registered")
	}
	if tgt.Name() == "" || tgt.InjectionType() != "sandbox" {
		t.Errorf("bad target meta: name=%q type=%q", tgt.Name(), tgt.InjectionType())
	}
	if got := targetRequiredProduct("claude_sandbox"); got != "anthropic" {
		t.Errorf("required product=%q want anthropic", got)
	}
}
