package main

import (
	"fmt"
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
	HypervisorOK    bool   `json:"hypervisorOK"`    // 兼容旧字段:== (HypervisorState=="ready")
	HypervisorState string `json:"hypervisorState"` // "ready"(可用) | "pending"(已启用·待重启) | "off"(需启用)
	FirmwareVirtOK  bool   `json:"firmwareVirtOK"`  // BIOS/UEFI CPU 虚拟化(VT-x/AMD-V)已开
	Note            string `json:"note"`
}

// windowsPrereq 查 WHP 三态(功能 State + hypervisor 是否真在跑)+ 固件虚拟化是否开。仅 Windows 真查;
// 抑制态/非 Windows 返回全 OK(其它平台由 KvmOK / Apple 芯片各自的检查覆盖,这里不干扰)。
func windowsPrereq() WinPrereq {
	if appActionsSuppressed() || runtime.GOOS != "windows" {
		return WinPrereq{HypervisorOK: true, HypervisorState: "ready", FirmwareVirtOK: true}
	}
	p := WinPrereq{}
	// WHP 功能状态:(...).State 打印 "Enabled" / "Disabled" / "EnablePending"。
	state, _ := hideCmd("powershell", "-NoProfile", "-Command",
		"(Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform).State").Output()
	// hypervisor 是否真在运行(重启后才 True):HypervisorPresent = 「能不能用」的真信号,分辨「待重启」与「未启用」。
	present, _ := hideCmd("powershell", "-NoProfile", "-Command",
		"(Get-CimInstance Win32_ComputerSystem).HypervisorPresent").Output()
	p.HypervisorState = hypervisorStatus(string(state), strings.Contains(strings.ToLower(string(present)), "true"))
	p.HypervisorOK = p.HypervisorState == "ready"
	// 固件虚拟化:Win32_Processor.VirtualizationFirmwareEnabled → True/False
	out2, _ := hideCmd("powershell", "-NoProfile", "-Command",
		"(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled").Output()
	p.FirmwareVirtOK = strings.Contains(strings.ToLower(string(out2)), "true")
	if !p.FirmwareVirtOK {
		p.Note = "CPU 虚拟化未在 BIOS/UEFI 开启,需自行进 BIOS 打开(VT-x / AMD-V),软件改不了"
	}
	return p
}

// windowsSupportsSbx 查 OS 是否满足 sbx 硬前提(Win11 非 Server)。仅供 DetectSbx。
// fail-open:查询失败(空输出)→ 返回支持,别因一次读取失败误弹「不支持」硬墙。
func windowsSupportsSbx() (ok bool, osName string) {
	out, _ := hideCmd("powershell", "-NoProfile", "-Command",
		`$o=Get-CimInstance Win32_OperatingSystem; "$($o.Caption)|$($o.BuildNumber)"`).Output()
	caption, build := parseOSInfo(string(out))
	if caption == "" && build == 0 {
		return true, "" // 查不到 → fail-open,不硬拦
	}
	return osSupportsSbx(caption, build), caption
}

// hypervisorBlockedError 若 Windows WHP 未就绪,返回可操作的中文错误(区分未启用 / 已启用待重启 /
// 固件虚拟化未开);就绪或非 Windows(windowsPrereq 已短路返回 OK)→ nil。用于 SandboxCreate 在跑
// sbx create 前硬闸:不然用户在 WHP 关着时点创建,只会吃 Docker 的裸 500「Hypervisor Platform is
// not enabled」,毫无指引。这就是「检测/一键启用/警告横幅都有,却没接成硬闸」那个坑的后端兜底。
func hypervisorBlockedError(p WinPrereq) error {
	if p.HypervisorOK {
		return nil
	}
	if p.HypervisorState == "pending" {
		return fmt.Errorf("已启用 Windows Hypervisor Platform,但需重启电脑后才生效——请重启后再创建沙箱")
	}
	if !p.FirmwareVirtOK {
		return fmt.Errorf("需启用 Windows Hypervisor Platform,且 CPU 虚拟化未在 BIOS/UEFI 开启(VT-x/AMD-V):先进 BIOS 打开虚拟化,再到接管中心点「一键启用」并重启")
	}
	return fmt.Errorf("需先启用 Windows Hypervisor Platform:到接管中心点「一键启用」,完成后重启电脑再创建沙箱")
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
	// hideCmd 藏掉发起提权的 launcher 黑框;真正干活的是它 Start-Process 起的提权 PowerShell(UAC 弹窗照常)。
	return hideCmd("powershell", "-NoProfile", "-Command", elevate).Start()
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
