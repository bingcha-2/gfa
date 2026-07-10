package main

import (
	"os"
	"testing"
)

func withHostProtectionTestDir(t *testing.T) {
	t.Helper()
	old := origConfigDir
	origConfigDir = t.TempDir()
	t.Cleanup(func() {
		_ = removeHostProtectionSnapshot()
		origConfigDir = old
	})
}

func TestHostProtectionApplyStatusRestoreLifecycle(t *testing.T) {
	withHostProtectionTestDir(t)
	app := NewApp()

	status, err := app.ApplyHostProtection(HostProtectionConfig{
		TimezoneStrategy: "fixed",
		FixedTimezone:    "Asia/Singapore",
		// 即使旧前端传 false，后端也必须强制执行接管基线。
		BlockWebRTC:      false,
		BlockGeolocation: false,
		Targets:          []string{"claude_code", "claude_desktop"},
	})
	if err != nil {
		t.Fatalf("ApplyHostProtection: %v", err)
	}
	if status.Mode != "active" || status.AppliedTimezone != "Asia/Singapore" {
		t.Fatalf("unexpected active status: %+v", status)
	}
	if !status.BlockWebRTC || !status.BlockGeolocation {
		t.Fatalf("mandatory protection baseline was not applied: %+v", status)
	}
	if got := hostProtectionProcessTimezone(); got != "Asia/Singapore" {
		t.Fatalf("process TZ = %q", got)
	}
	args := hostProtectionChromiumArgs()
	if !hasArg(args, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp") || !hasArg(args, "--deny-permission-prompts") {
		t.Fatalf("missing Chromium protections: %v", args)
	}

	status, err = app.GetHostProtectionStatus()
	if err != nil || status.Mode != "active" {
		t.Fatalf("GetHostProtectionStatus = %+v, %v", status, err)
	}
	status, err = app.RestoreHostProtection()
	if err != nil {
		t.Fatalf("RestoreHostProtection: %v", err)
	}
	if status.Mode != "restored" || status.BlockWebRTC || status.BlockGeolocation {
		t.Fatalf("unexpected restored status: %+v", status)
	}
	if _, err := os.Stat(hostProtectionSnapshotPath()); !os.IsNotExist(err) {
		t.Fatalf("snapshot should be removed, stat err=%v", err)
	}
	configure, err := app.GetHostProtectionStatus()
	if err != nil || configure.Mode != "configure" || !configure.BlockWebRTC || !configure.BlockGeolocation {
		t.Fatalf("next configuration should restore safe defaults: %+v, %v", configure, err)
	}
}

func TestHostProtectionBrowserPreferencesRoundTrip(t *testing.T) {
	withHostProtectionTestDir(t)
	path := hostClaudePreferencesPath()
	seed := map[string]interface{}{
		"profile": map[string]interface{}{"default_content_setting_values": map[string]interface{}{"geolocation": 1.0}},
		"webrtc":  map[string]interface{}{"ip_handling_policy": "default"},
		"keep":    "user-value",
	}
	if err := writeHostPreferenceDocument(path, seed, 0o600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	_, err := app.ApplyHostProtection(HostProtectionConfig{
		TimezoneStrategy: "fixed", FixedTimezone: "Asia/Singapore",
		BlockWebRTC: true, BlockGeolocation: true, Targets: []string{"claude_desktop"},
	})
	if err != nil {
		t.Fatal(err)
	}
	applied, _, _, err := readHostPreferenceDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	if value, _ := getHostNestedPreference(applied, hostGeolocationPreferencePath); value != float64(2) {
		t.Fatalf("geolocation pref = %#v", value)
	}
	if value, _ := getHostNestedPreference(applied, hostWebRTCPreferencePath); value != "disable_non_proxied_udp" {
		t.Fatalf("webrtc pref = %#v", value)
	}
	if _, err := app.RestoreHostProtection(); err != nil {
		t.Fatal(err)
	}
	restored, _, _, err := readHostPreferenceDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	if value, _ := getHostNestedPreference(restored, hostGeolocationPreferencePath); value != float64(1) {
		t.Fatalf("restored geolocation pref = %#v", value)
	}
	if value, _ := getHostNestedPreference(restored, hostWebRTCPreferencePath); value != "default" {
		t.Fatalf("restored webrtc pref = %#v", value)
	}
	if restored["keep"] != "user-value" {
		t.Fatalf("unrelated preference lost: %#v", restored)
	}
}

func TestHostProtectionOldPIDBecomesResidue(t *testing.T) {
	withHostProtectionTestDir(t)
	snap := &hostProtectionSnapshot{
		Version:                 hostProtectionSnapshotVersion,
		State:                   "active",
		OwnerPID:                os.Getpid() + 1000,
		OriginalSystemTimezone:  "Asia/Shanghai",
		OriginalDisplayTimezone: "Asia/Shanghai",
		AppliedTimezone:         "Asia/Singapore",
		TimezoneStrategy:        "follow",
		TimezoneChanged:         true,
		BlockWebRTC:             true,
		Targets:                 []string{"claude"},
	}
	if err := writeHostProtectionSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	status, err := NewApp().GetHostProtectionStatus()
	if err != nil || status.Mode != "residue" {
		t.Fatalf("old PID should be residue: %+v, %v", status, err)
	}
	if got := hostProtectionProcessTimezone(); got != "" {
		t.Fatalf("residue must not inject TZ, got %q", got)
	}
}

func TestHostProtectionCanReleaseTargetsIndividually(t *testing.T) {
	withHostProtectionTestDir(t)
	app := NewApp()
	_, err := app.ApplyHostProtection(HostProtectionConfig{
		TimezoneStrategy: "fixed", FixedTimezone: "Asia/Singapore",
		BlockWebRTC: true, Targets: []string{"claude", "claude_desktop"},
	})
	if err != nil {
		t.Fatal(err)
	}
	status, err := app.ReleaseHostProtectionTarget("claude_desktop")
	if err != nil || status.Mode != "active" || len(status.Targets) != 1 || status.Targets[0] != "claude" {
		t.Fatalf("release desktop = %+v, %v", status, err)
	}
	status, err = app.ReleaseHostProtectionTarget("claude")
	if err != nil || status.Mode != "restored" {
		t.Fatalf("release last target = %+v, %v", status, err)
	}
}

func TestHostProtectionRejectsUnsafeFixedTimezone(t *testing.T) {
	withHostProtectionTestDir(t)
	_, err := NewApp().ApplyHostProtection(HostProtectionConfig{
		TimezoneStrategy: "fixed",
		FixedTimezone:    "Asia/Shanghai",
		Targets:          []string{"claude"},
	})
	if err == nil {
		t.Fatal("unsafe fixed timezone should be rejected")
	}
}

func TestWindowsTimezoneMappingsCoverFixedChoices(t *testing.T) {
	for tz := range fixedHostProtectionTimezones {
		if id, ok := ianaToWindowsTimezoneID(tz); !ok || id == "" {
			t.Errorf("missing Windows mapping for %s", tz)
		}
	}
	if id, _ := ianaToWindowsTimezoneID("Asia/Manila"); id != "Singapore Standard Time" {
		t.Fatalf("Asia/Manila collapsed mapping = %q", id)
	}
}
