package main

import (
	"os"
	"path/filepath"
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

func TestRestoreHostBrowserPreferencesOutcome(t *testing.T) {
	t.Run("reverts both prefs in a pre-existing file", func(t *testing.T) {
		withHostProtectionTestDir(t)
		path := hostClaudePreferencesPath()
		seed := map[string]interface{}{
			"profile": map[string]interface{}{"default_content_setting_values": map[string]interface{}{"geolocation": 1.0}},
			"webrtc":  map[string]interface{}{"ip_handling_policy": "default"},
		}
		if err := writeHostPreferenceDocument(path, seed, 0o600); err != nil {
			t.Fatal(err)
		}
		snap := &hostProtectionSnapshot{BlockWebRTC: true, BlockGeolocation: true, Targets: []string{"claude_desktop"}}
		if err := captureHostBrowserPreferences(snap); err != nil {
			t.Fatal(err)
		}
		if err := applyHostBrowserPreferences(snap); err != nil {
			t.Fatal(err)
		}
		out, err := restoreHostBrowserPreferences(snap)
		if err != nil {
			t.Fatal(err)
		}
		if !out.WebRTC || !out.Geolocation {
			t.Fatalf("expected both prefs restored, got %+v", out)
		}
		if out.Skipped || out.FileRemoved {
			t.Fatalf("existing file should be rewritten in place, got %+v", out)
		}
	})

	t.Run("removes the file it created when none existed before", func(t *testing.T) {
		withHostProtectionTestDir(t)
		path := hostClaudePreferencesPath()
		snap := &hostProtectionSnapshot{BlockWebRTC: true, BlockGeolocation: true, Targets: []string{"claude_desktop"}}
		if err := captureHostBrowserPreferences(snap); err != nil {
			t.Fatal(err)
		}
		if err := applyHostBrowserPreferences(snap); err != nil {
			t.Fatal(err)
		}
		out, err := restoreHostBrowserPreferences(snap)
		if err != nil {
			t.Fatal(err)
		}
		if !out.FileRemoved {
			t.Fatalf("file created by takeover should be removed, got %+v", out)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Fatalf("preferences file should be gone, stat err=%v", statErr)
		}
	})
}

func TestHostChromiumBrowserProtectionForCLITakeover(t *testing.T) {
	withHostProtectionTestDir(t)
	// 造一个伪 chrome profile 的 Preferences(chromiumBrowsers() 测试态就指向 origConfigDir/test-chrome）。
	prefsPath := filepath.Join(origConfigDir, "test-chrome", "User Data", "Default", "Preferences")
	seed := map[string]interface{}{
		"profile": map[string]interface{}{"default_content_setting_values": map[string]interface{}{"geolocation": 1.0}},
		"webrtc":  map[string]interface{}{"ip_handling_policy": "default"},
		"keep":    "user-value",
	}
	if err := writeHostPreferenceDocument(prefsPath, seed, 0o600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	// 关键:仅接管 Claude Code(CLI),真实浏览器仍应被防护(机器级、与目标解耦)。
	if _, err := app.ApplyHostProtection(HostProtectionConfig{
		TimezoneStrategy: "fixed", FixedTimezone: "Asia/Singapore",
		BlockWebRTC: true, BlockGeolocation: true, Targets: []string{"claude"},
	}); err != nil {
		t.Fatal(err)
	}
	applied, _, _, err := readHostPreferenceDocument(prefsPath)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := getHostNestedPreference(applied, hostWebRTCPreferencePath); v != "disable_non_proxied_udp" {
		t.Fatalf("CLI 接管未防护真实浏览器 webrtc: %#v", v)
	}
	if v, _ := getHostNestedPreference(applied, hostGeolocationPreferencePath); v != float64(2) {
		t.Fatalf("CLI 接管未防护真实浏览器 geolocation: %#v", v)
	}

	if _, err := app.RestoreHostProtection(); err != nil {
		t.Fatal(err)
	}
	restored, _, _, err := readHostPreferenceDocument(prefsPath)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := getHostNestedPreference(restored, hostWebRTCPreferencePath); v != "default" {
		t.Fatalf("还原后 webrtc 未回原值: %#v", v)
	}
	if v, _ := getHostNestedPreference(restored, hostGeolocationPreferencePath); v != float64(1) {
		t.Fatalf("还原后 geolocation 未回原值: %#v", v)
	}
	if restored["keep"] != "user-value" {
		t.Fatalf("还原误伤无关字段: %#v", restored)
	}
}

func TestBrowserProfilesSummary(t *testing.T) {
	if got := browserProfilesSummary(nil); got != "无" {
		t.Errorf("empty summary = %q want 无", got)
	}
	profiles := []browserProfileBackup{{Browser: "chrome"}, {Browser: "chrome"}, {Browser: "edge"}}
	if got := browserProfilesSummary(profiles); got != "chrome×2 edge×1" {
		t.Errorf("summary = %q want chrome×2 edge×1", got)
	}
}

func TestOverallProtectionState(t *testing.T) {
	cases := []struct {
		intended bool
		browsers int
		desktop  bool
		want     string
	}{
		{false, 0, false, "关"},
		{true, 2, false, "已写入"}, // 仅真实浏览器(CLI 接管)
		{true, 0, true, "已写入"},  // 仅 Claude Desktop
		{true, 0, false, "无可写目标"},
	}
	for _, c := range cases {
		if got := overallProtectionState(c.intended, c.browsers, c.desktop); got != c.want {
			t.Errorf("overallProtectionState(%v,%d,%v)=%q want %q", c.intended, c.browsers, c.desktop, got, c.want)
		}
	}
}

func TestApplyBrowserState(t *testing.T) {
	cases := []struct {
		intended, applied bool
		want              string
	}{
		{false, false, "关"},  // 未要求
		{false, true, "关"},   // 未要求(即便碰巧写过也以意图为准)
		{true, true, "已写入"},  // 要求且真写进了 Desktop prefs
		{true, false, "不适用"}, // 要求但无 Desktop 可写(仅 Code 接管)
	}
	for _, c := range cases {
		if got := applyBrowserState(c.intended, c.applied); got != c.want {
			t.Errorf("applyBrowserState(%v,%v)=%q want %q", c.intended, c.applied, got, c.want)
		}
	}
}

func TestAppliedSystemNote(t *testing.T) {
	if got := appliedSystemNote("America/Chicago", ""); got != "" {
		t.Errorf("empty applied system should note nothing, got %q", got)
	}
	if got := appliedSystemNote("America/Chicago", "America/Chicago"); got != "" {
		t.Errorf("matching value should note nothing, got %q", got)
	}
	if got := appliedSystemNote("America/Chicago", "Central Standard Time"); got != "(系统档=Central Standard Time)" {
		t.Errorf("windows collapse should be surfaced, got %q", got)
	}
}

func TestTimezoneMatchState(t *testing.T) {
	cases := []struct {
		name             string
		applied, current string
		want             string
	}{
		{"exact", "America/Chicago", "America/Chicago", "aligned"},
		{"windows-collapse", "America/Winnipeg", "America/Chicago", "collapsed"}, // 同为 Central Standard Time
		{"manila-singapore-collapse", "Asia/Manila", "Asia/Singapore", "collapsed"},
		{"real-drift", "America/Chicago", "Asia/Shanghai", "drift"},
		{"empty-applied", "", "America/Chicago", "na"},
		{"empty-current", "America/Chicago", "", "na"},
	}
	for _, c := range cases {
		if got := timezoneMatchState(c.applied, c.current); got != c.want {
			t.Errorf("%s: timezoneMatchState(%q,%q)=%q want %q", c.name, c.applied, c.current, got, c.want)
		}
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
