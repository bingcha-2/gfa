package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRetiredCodexRelayCannotBypassServerAccount(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(200) }))
	defer upstream.Close()
	proxy := &CodexProxy{}
	proxy.ApplyConfig(Config{CodexMode: "relay", CodexRelayBase: upstream.URL, CodexRelayKey: "retired-personal-key"})
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"gpt-test","input":"hello"}`))
	reply := httptest.NewRecorder()
	proxy.ServeHTTP(reply, req, "", "test-device", "")
	if reply.Code != http.StatusServiceUnavailable || called {
		t.Fatalf("retired local credentials bypassed server authorization: %d", reply.Code)
	}
}

func TestLegacyTimezoneRestoresOriginalAndPreservesLaterChoice(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	writeClaudeBackup(&claudeBackup{OriginalCaptured: true, Original: `{"env":{"TZ":"Europe/London"}}`})
	writeSettings(t, claudeConfigDir(), `{"env":{"TZ":"Asia/Singapore","KEEP":"value"}}`)
	if err := restoreLegacyClaudeTimezone("Asia/Singapore"); err != nil {
		t.Fatal(err)
	}
	env := envOf(readSettings(t, claudeConfigDir()))
	if env["TZ"] != "Europe/London" || env["KEEP"] != "value" {
		t.Fatal("original timezone not restored", env)
	}
	writeSettings(t, claudeConfigDir(), `{"env":{"TZ":"user-choice"}}`)
	if err := restoreLegacyClaudeTimezone("Asia/Singapore"); err != nil {
		t.Fatal(err)
	}
	if envOf(readSettings(t, claudeConfigDir()))["TZ"] != "user-choice" {
		t.Fatal("overwrote newer user timezone")
	}
}

func TestLegacyHostRestoresPreferencesAndKeepsUserSettings(t *testing.T) {
	old := origConfigDir
	origConfigDir = t.TempDir()
	t.Cleanup(func() { origConfigDir = old })
	prefs := filepath.Join(origConfigDir, "Preferences")
	if err := writeDesktopJSON(prefs, map[string]interface{}{"keep": "user-setting", "webrtc": map[string]interface{}{"ip_handling_policy": "disable_non_proxied_udp"}}); err != nil {
		t.Fatal(err)
	}
	snap := hostProtectionSnapshot{Version: hostProtectionSnapshotVersion, BrowserPreferencesChanged: true, BrowserPreferencesPath: prefs, BrowserPreferencesHadFile: true, BlockWebRTC: true, WebRTCPreference: hostPreferenceBackup{Present: true, Value: json.RawMessage(`"default"`)}}
	if err := writeDesktopJSON(hostProtectionSnapshotPath(), snap); err != nil {
		t.Fatal(err)
	}
	if err := restoreLegacyHostEnvironment(); err != nil {
		t.Fatal(err)
	}
	doc, _, err := readDesktopJSON(prefs)
	if err != nil {
		t.Fatal(err)
	}
	if doc["keep"] != "user-setting" || doc["webrtc"].(map[string]interface{})["ip_handling_policy"] != "default" {
		t.Fatal("lost original settings", doc)
	}
	if _, err := os.Stat(hostProtectionSnapshotPath()); !os.IsNotExist(err) {
		t.Fatal("snapshot retained", err)
	}
	if err := restoreLegacyHostEnvironment(); err != nil {
		t.Fatal("migration not idempotent", err)
	}
}

func TestLegacyHostKeepsSnapshotWhenRestoreFails(t *testing.T) {
	old := origConfigDir
	origConfigDir = t.TempDir()
	t.Cleanup(func() { origConfigDir = old })
	prefs := filepath.Join(origConfigDir, "Preferences")
	if err := os.WriteFile(prefs, []byte("invalid-json"), 0600); err != nil {
		t.Fatal(err)
	}
	snap := hostProtectionSnapshot{Version: hostProtectionSnapshotVersion, BrowserPreferencesChanged: true, BrowserPreferencesPath: prefs, BrowserPreferencesHadFile: true}
	if err := writeDesktopJSON(hostProtectionSnapshotPath(), snap); err != nil {
		t.Fatal(err)
	}
	if err := restoreLegacyHostEnvironment(); err == nil {
		t.Fatal("expected failed restore")
	}
	if _, err := os.Stat(hostProtectionSnapshotPath()); err != nil {
		t.Fatal("lost recovery snapshot", err)
	}
}

func TestLegacySandboxOnlyRemovesOwnedWrapper(t *testing.T) {
	for _, wrapper := range []string{vscodeWrapperPath(), "/user/custom-wrapper"} {
		t.Run(wrapper, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "settings.json")
			if err := writeDesktopJSON(path, map[string]interface{}{vscodeWrapperSettingKey: wrapper, "editor.fontSize": 18}); err != nil {
				t.Fatal(err)
			}
			if err := clearVscodeWrapperSetting(path); err != nil {
				t.Fatal(err)
			}
			doc, _, err := readDesktopJSON(path)
			if err != nil {
				t.Fatal(err)
			}
			if doc["editor.fontSize"] != float64(18) {
				t.Fatal("changed editor setting")
			}
			_, present := doc[vscodeWrapperSettingKey]
			if present != (wrapper != vscodeWrapperPath()) {
				t.Fatal("incorrect wrapper ownership handling")
			}
		})
	}
}

func TestLegacyLocalAccountRestoresWithoutDeletingAccountDatabase(t *testing.T) {
	old := origConfigDir
	origConfigDir = t.TempDir()
	t.Cleanup(func() { origConfigDir = old })
	t.Setenv("CODEX_HOME", t.TempDir())
	sources := filepath.Join(getAppDataDir(), "local", "sources.json")
	if err := writeDesktopJSON(sources, map[string]string{"codex": "local", "antigravity": "local"}); err != nil {
		t.Fatal(err)
	}
	database := filepath.Join(getAppDataDir(), "local", "accounts.json")
	if err := os.WriteFile(database, []byte("preserve-account-data"), 0600); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"original":"auth"}`)
	if err := os.WriteFile(filepath.Join(codexHomeDir(), ".bcai-codex-auth-backup.json"), original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexAuthPath(), []byte(`{"projected":"auth"}`), 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := restoreCodexLocalSourceBeforeRemote()
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	restored, err := os.ReadFile(codexAuthPath())
	if err != nil || string(restored) != string(original) {
		t.Fatal("original auth lost", err)
	}
	data, err := os.ReadFile(database)
	if err != nil || string(data) != "preserve-account-data" {
		t.Fatal("account data modified", err)
	}
	changed, err = restoreCodexLocalSourceBeforeRemote()
	if err != nil || changed {
		t.Fatal("not idempotent", err)
	}
}

func TestRetiredTakeoverTargetsAreNotRegistered(t *testing.T) {
	for _, name := range []string{"claude_sandbox", "claude_vscode_sandbox"} {
		if findTakeoverTarget(name) != nil {
			t.Fatal("retired target registered", name)
		}
	}
}
