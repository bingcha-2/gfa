package main

import "testing"

func TestWindowsPrereqSuppressed(t *testing.T) {
	// 抑制态(go test)不触 PowerShell,返回全 OK 不打扰。
	p := windowsPrereq()
	if !p.HypervisorOK || !p.FirmwareVirtOK {
		t.Errorf("suppressed windowsPrereq should be all-OK, got %+v", p)
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
