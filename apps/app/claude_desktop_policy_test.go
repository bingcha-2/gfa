package main

import "testing"

const sampleRegQuery = `
HKEY_CURRENT_USER\SOFTWARE\Policies\Claude
    inferenceProvider    REG_SZ    gateway
    inferenceGatewayBaseUrl    REG_SZ    https://api.opusapi.xyz
    inferenceCredentialHelper    REG_SZ    C:\Users\u\.opusclaude\desktop-helper.ps1
    disableAutoUpdates    REG_DWORD    0x1
`

func TestDesktopPolicyConflictDetectsForeignGateway(t *testing.T) {
	v := parseRegQueryValues(sampleRegQuery)
	if v["inferenceGatewayBaseUrl"] != "https://api.opusapi.xyz" || v["disableAutoUpdates"] != "0x1" {
		t.Fatalf("parse failed: %v", v)
	}
	if desktopPolicyConflictIn("HKCU", v, "https://gfa.example/gateway") == "" {
		t.Fatal("foreign gateway policy must conflict")
	}
}

func TestDesktopPolicyConflictIgnoresUnrelatedPolicy(t *testing.T) {
	v := parseRegQueryValues("    disableAutoUpdates    REG_DWORD    0x1\n")
	if got := desktopPolicyConflictIn("HKCU", v, "https://gfa.example/gateway"); got != "" {
		t.Fatalf("unexpected conflict: %s", got)
	}
}

func TestMsixAppUserModelID(t *testing.T) {
	p := `C:\Program Files\WindowsApps\Claude_2.42304.2.0_x64__pzs8sxrjxfjjc\app\Claude.exe`
	if got := msixAppUserModelID(p); got != "Claude_pzs8sxrjxfjjc!Claude" {
		t.Fatalf("got %q", got)
	}
	if msixAppUserModelID(`C:\Users\u\AppData\Local\AnthropicClaude\claude.exe`) != "" {
		t.Fatal("non-MSIX path must yield empty")
	}
}

func TestPolicyValuesToClearOnlyGatewayOwned(t *testing.T) {
	v := parseRegQueryValues(sampleRegQuery)
	got := policyValuesToClear(v)
	want := []string{"inferenceProvider", "inferenceGatewayBaseUrl", "inferenceCredentialHelper"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	for _, n := range got {
		if n == "disableAutoUpdates" {
			t.Fatal("unrelated policy value must not be cleared")
		}
	}
}
