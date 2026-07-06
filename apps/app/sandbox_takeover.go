package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// ─── 沙箱模式接管 · 触机器 + target 层 ─────────────────────────────────────────
//
// 纯函数在 sandbox_kit.go。这里放落盘(GenerateKit)、触机器动作(DetectSbx /
// ApplyPolicy / InstallSbx,均过 appActionsSuppressed() 短路)、以及接管中心注册表
// 的 claudeSandboxTarget。冰茶只准备,交互式 sbx run 由用户在自己终端跑。

// SbxStatus sbx 安装状态,供卡片展示。
type SbxStatus struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
	KvmOK     bool   `json:"kvmOK"` // 仅 Linux 有意义
	Note      string `json:"note"`
}

// sandboxKitDir 返回 kit 的固定落盘路径(<用户配置目录>/bcai/sandbox/gfa-claude)。
func sandboxKitDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "bcai", "sandbox", "gfa-claude"), nil
}

// generateKitInto 把 kit.yaml + settings.json 写进 dir。纯 IO,便于用 temp 目录测试。
func generateKitInto(dir string, o KitOptions) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "kit.yaml"), []byte(kitYAML(o)), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "settings.json"), []byte(sandboxSettingsJSON(o.GatewayPort)), 0o644)
}

// GenerateKit 用默认落盘路径生成 kit,返回 kit 目录。
func GenerateKit(o KitOptions) (string, error) {
	dir, err := sandboxKitDir()
	if err != nil {
		return "", err
	}
	if err := generateKitInto(dir, o); err != nil {
		return "", fmt.Errorf("生成 kit 失败: %w", err)
	}
	return dir, nil
}

// DetectSbx 检测 sbx 是否可用。抑制态(go test)直接返回未装,不 exec。
func DetectSbx() SbxStatus {
	if appActionsSuppressed() {
		return SbxStatus{}
	}
	path, err := exec.LookPath("sbx")
	if err != nil {
		return SbxStatus{Installed: false, Note: "未检测到 sbx"}
	}
	out, _ := exec.Command(path, "version").Output()
	st := SbxStatus{Installed: true, Version: string(out)}
	if runtime.GOOS == "linux" {
		if _, err := os.Stat("/dev/kvm"); err == nil {
			st.KvmOK = true
		} else {
			st.Note = "缺少 /dev/kvm:Linux 需裸机 + KVM(虚拟机内不可用)"
		}
	}
	return st
}

// ApplyPolicy 放行宿主网关端口。抑制态短路。
func ApplyPolicy(gatewayPort int) error {
	if appActionsSuppressed() {
		return nil
	}
	return exec.Command("sbx", policyAllowArgs(gatewayPort)...).Run()
}

// InstallSbx 按平台装 sbx。抑制态短路。
func InstallSbx() error {
	if appActionsSuppressed() {
		return nil
	}
	name, args, err := installSbxCommand(runtime.GOOS)
	if err != nil {
		return err
	}
	return exec.Command(name, args...).Run()
}

// revokeSandbox 删 kit 目录 + 撤 policy(抑制态只删目录不 exec)。
func revokeSandbox(gatewayPort int) error {
	if dir, err := sandboxKitDir(); err == nil {
		_ = os.RemoveAll(dir)
	}
	if appActionsSuppressed() {
		return nil
	}
	return exec.Command("sbx", "policy", "deny", "network", fmt.Sprintf("localhost:%d", gatewayPort)).Run()
}

// ── 接管中心注册表目标 ──────────────────────────────────────────────────────
//
// claudeSandboxTarget 沙箱模式接管目标。Inject=生成默认 kit + 放行 policy;
// Restore=撤 policy + 删 kit。带挂载/时区的富流程走 local_bindings_sandbox.go。

type claudeSandboxTarget struct{}

func (claudeSandboxTarget) Key() string           { return "claude_sandbox" }
func (claudeSandboxTarget) ProductID() string     { return "claude_sandbox" }
func (claudeSandboxTarget) Name() string          { return "Claude Code · 沙箱模式" }
func (claudeSandboxTarget) InjectionType() string { return "sandbox" }

func (claudeSandboxTarget) DetectPath() string {
	if p, err := exec.LookPath("sbx"); err == nil {
		return p
	}
	return ""
}

func (claudeSandboxTarget) IsInjected(_ int) bool {
	dir, err := sandboxKitDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, "kit.yaml"))
	return err == nil
}

func (claudeSandboxTarget) Inject(proxyPort int) (string, error) {
	if _, err := GenerateKit(defaultKitOptions(proxyPort)); err != nil {
		return "", err
	}
	if err := ApplyPolicy(proxyPort); err != nil {
		return "", fmt.Errorf("放行网关端口失败: %w", err)
	}
	return "沙箱模式: ✓ 已配置,复制命令到终端运行 sbx run", nil
}

func (claudeSandboxTarget) Restore() (string, error) {
	if err := revokeSandbox(effectiveProxyPort()); err != nil {
		return "", err
	}
	return "沙箱模式: ✓ 已移除 kit", nil
}
