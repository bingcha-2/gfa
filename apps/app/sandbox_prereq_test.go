package main

import (
	"strings"
	"testing"
)

func TestWindowsPrereqSuppressed(t *testing.T) {
	// 抑制态(go test)不触 PowerShell,返回全 OK 不打扰。
	p := windowsPrereq()
	if !p.HypervisorOK || !p.FirmwareVirtOK {
		t.Errorf("suppressed windowsPrereq should be all-OK, got %+v", p)
	}
}

func TestHypervisorBlockedError(t *testing.T) {
	// 就绪 → 放行(非 Windows/抑制态 windowsPrereq 即此形态)。
	if err := hypervisorBlockedError(WinPrereq{HypervisorOK: true, HypervisorState: "ready", FirmwareVirtOK: true}); err != nil {
		t.Errorf("ready 应放行,却拦了: %v", err)
	}
	// 已启用待重启 → 拦,提示重启。
	if err := hypervisorBlockedError(WinPrereq{HypervisorState: "pending", FirmwareVirtOK: true}); err == nil || !strings.Contains(err.Error(), "重启") {
		t.Errorf("pending 应提示重启,got %v", err)
	}
	// 未启用 + 固件虚拟化开着 → 拦,提示一键启用。
	if err := hypervisorBlockedError(WinPrereq{HypervisorState: "off", FirmwareVirtOK: true}); err == nil || !strings.Contains(err.Error(), "一键启用") {
		t.Errorf("off 应提示一键启用,got %v", err)
	}
	// 未启用 + 固件虚拟化也没开 → 拦,提示进 BIOS。
	if err := hypervisorBlockedError(WinPrereq{HypervisorState: "off", FirmwareVirtOK: false}); err == nil || !strings.Contains(err.Error(), "BIOS") {
		t.Errorf("固件虚拟化未开应提示进 BIOS,got %v", err)
	}
}

func TestEnableWindowsHypervisorSuppressed(t *testing.T) {
	if err := enableWindowsHypervisor(); err != nil {
		t.Errorf("suppressed enableWindowsHypervisor should no-op, got %v", err)
	}
}

func TestSbxLoginSuppressed(t *testing.T) {
	if err := SbxLogin(); err != nil {
		t.Errorf("suppressed SbxLogin should no-op, got %v", err)
	}
}
