package main

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// ─── 沙箱前置条件(Windows Hypervisor Platform)+ sbx 登录 ──────────────────────
//
// 全是触机器动作,过 appActionsSuppressed() 短路。Windows 专属逻辑走 runtime.GOOS 判断
// (exec 命令字符串跨平台可编译,只在对的平台才真跑)。这些【未在真 Windows 上验证】,
// 待有真机后核对:PowerShell 输出格式、UAC 提权、以及 sbx login 的交互形态。

// WinPrereq Windows 沙箱前置状态(非 Windows 平台字段无意义,统一返回 OK 不打扰)。
type WinPrereq struct {
	HypervisorOK   bool   `json:"hypervisorOK"`   // Windows Hypervisor Platform 已启用
	FirmwareVirtOK bool   `json:"firmwareVirtOK"` // BIOS/UEFI CPU 虚拟化(VT-x/AMD-V)已开
	Note           string `json:"note"`
}

// windowsPrereq 查 WHP 是否启用 + 固件虚拟化是否开。仅 Windows 真查;抑制态/非 Windows
// 返回全 OK(其它平台由 KvmOK / Apple 芯片各自的检查覆盖,这里不干扰)。
func windowsPrereq() WinPrereq {
	if appActionsSuppressed() || runtime.GOOS != "windows" {
		return WinPrereq{HypervisorOK: true, FirmwareVirtOK: true}
	}
	p := WinPrereq{}
	// WHP 功能状态:(...).State 打印 "Enabled" / "Disabled"。("disabled" 不含子串 "enabled")
	out, _ := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform).State").Output()
	p.HypervisorOK = strings.Contains(strings.ToLower(string(out)), "enabled")
	// 固件虚拟化:Win32_Processor.VirtualizationFirmwareEnabled → True/False
	out2, _ := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled").Output()
	p.FirmwareVirtOK = strings.Contains(strings.ToLower(string(out2)), "true")
	if !p.FirmwareVirtOK {
		p.Note = "CPU 虚拟化未在 BIOS/UEFI 开启,需自行进 BIOS 打开(VT-x / AMD-V),软件改不了"
	}
	return p
}

// enableWindowsHypervisor 弹 UAC 提权启用 WHP(-NoRestart:不自动重启,由用户手动重启)。
// 仅 Windows;抑制态短路。
func enableWindowsHypervisor() error {
	if appActionsSuppressed() {
		return nil
	}
	if runtime.GOOS != "windows" {
		return fmt.Errorf("仅 Windows 需要启用 Hypervisor Platform")
	}
	inner := "Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart"
	elevate := fmt.Sprintf("Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','%s'", inner)
	return exec.Command("powershell", "-NoProfile", "-Command", elevate).Start()
}

// SbxLogin 开终端跑 sbx login(交互式:走浏览器/设备码鉴权,必须在终端里,不能静默)。
// 抑制态短路。sbx 未装则报错。
func SbxLogin() error {
	if appActionsSuppressed() {
		return nil
	}
	if resolveSbxPath() == "" {
		return fmt.Errorf("未找到 sbx,请先安装")
	}
	return openTerminalRunning("sbx login")
}
