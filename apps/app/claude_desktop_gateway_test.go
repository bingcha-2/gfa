package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDesktopGatewayRollsBackPartialWrite(t *testing.T) {
	root := t.TempDir()
	normal, threep := filepath.Join(root, "Claude"), filepath.Join(root, "Claude-3p")
	config := filepath.Join(normal, "claude_desktop_config.json")
	original := map[string]interface{}{"deploymentMode": "firstParty", "keep": true}
	if err := writeDesktopJSON(config, original); err != nil {
		t.Fatal(err)
	}
	writer := writeDesktopGatewayFile
	t.Cleanup(func() { writeDesktopGatewayFile = writer })
	failed := false
	writeDesktopGatewayFile = func(path string, value interface{}) error {
		if path == filepath.Join(threep, "claude_desktop_config.json") && !failed {
			failed = true
			return errors.New("simulated disk failure")
		}
		return writer(path, value)
	}
	if err := injectDesktopGatewayAt(normal, threep, "https://example.test", "gfa-key", nil); err == nil {
		t.Fatal("expected partial write failure")
	}
	doc, _, err := readDesktopJSON(config)
	if err != nil || !reflect.DeepEqual(doc, original) {
		t.Fatal("lost original during rollback", err)
	}
	for _, path := range []string{desktopGatewayJournalPath(threep), filepath.Join(threep, "configLibrary", desktopGatewayProfileID+".json"), filepath.Join(threep, "configLibrary", "_meta.json")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("rollback left owned file %s: %v", path, err)
		}
	}
}

func TestDesktopGatewayActivationUsesExistingUserEndpoint(t *testing.T) {
	oldDir, oldBase := origConfigDir, authBaseURL
	origConfigDir = t.TempDir()
	t.Cleanup(func() { origConfigDir = oldDir; authBaseURL = oldBase })
	cfg := DefaultConfig()
	cfg.UserToken = "desktop-user-session"
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/app/gateway/activate" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer desktop-user-session" {
			t.Error("missing user session")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(GatewayActivation{Key: "gfa-existing-user", MotherAccountID: "existing-mother", Shares: 1, LimitUSD: 165, RemainingUSD: 120, Models: []string{"claude-sonnet-4-6"}})
	}))
	defer srv.Close()
	authBaseURL = srv.URL
	act, err := activateClaudeGateway()
	if err != nil {
		t.Fatal(err)
	}
	if act.Key != "gfa-existing-user" || act.MotherAccountID != "existing-mother" || act.RemainingUSD != 120 {
		t.Fatal("lost existing assignment", act)
	}
}

func TestDesktopMigrationPreservesCLIGatewayBackup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	writeSettings(t, dir, `{"env":{"ANTHROPIC_BASE_URL":"https://original.test"},"model":"sonnet"}`)
	if err := InjectClaudeGateway(testGatewayURL, "gfa-cli", []string{"claude-sonnet-4-6"}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(claudeBackupPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := RestoreClaudeModelConfig(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(claudeBackupPath())
	if err != nil || string(before) != string(after) {
		t.Fatal("Desktop migration touched CLI gateway backup", err)
	}
	if err := RestoreClaudeSettings(); err != nil {
		t.Fatal(err)
	}
	if envOf(readSettings(t, dir))[claudeBaseURLKey] != "https://original.test" {
		t.Fatal("CLI no longer restores independently")
	}
}

func TestDesktopLegacyCredentialsRestore(t *testing.T) {
	for _, existed := range []bool{true, false} {
		t.Run(map[bool]string{true: "existing", false: "absent"}[existed], func(t *testing.T) {
			t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
			original := []byte(`{"original":"credential"}`)
			b, _ := json.Marshal(claudeCredsBackup{Injected: true, Existed: existed, Prev: original})
			if err := os.WriteFile(claudeCredentialsBackupPath(), b, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(claudeCredentialsPath(), []byte(`{"old":"fake"}`), 0600); err != nil {
				t.Fatal(err)
			}
			if err := RestoreFakeClaudeCredentials(); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(claudeCredentialsPath())
			if existed && (err != nil || string(got) != string(original)) {
				t.Fatal("lost original credentials", err)
			}
			if !existed && !os.IsNotExist(err) {
				t.Fatal("left fake credentials", err)
			}
			if err := RestoreFakeClaudeCredentials(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDesktopGatewayRoundTrip(t *testing.T) {
	root := t.TempDir()
	normal, threep := filepath.Join(root, "Claude"), filepath.Join(root, "Claude-3p")
	config := filepath.Join(normal, "claude_desktop_config.json")
	initial := map[string]interface{}{"deploymentMode": "firstParty", "mcpServers": map[string]interface{}{"local": map[string]interface{}{"command": "example"}}}
	if err := writeDesktopJSON(config, initial); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"gfa-one", "gfa-rotated"} {
		if err := injectDesktopGatewayAt(normal, threep, "https://example.test/api/gateway", key, []string{"claude-sonnet-4-6"}); err != nil {
			t.Fatal(err)
		}
	}
	profile := filepath.Join(threep, "configLibrary", desktopGatewayProfileID+".json")
	doc, _, err := readDesktopJSON(profile)
	if err != nil {
		t.Fatal(err)
	}
	if doc["inferenceGatewayApiKey"] != "gfa-rotated" || doc["inferenceGatewayAuthScheme"] != "bearer" {
		t.Fatal("wrong native profile")
	}
	if stat, err := os.Stat(profile); err != nil || stat.Mode().Perm() != 0600 {
		t.Fatal("profile must be private", err)
	}
	if err := restoreDesktopGatewayAt(threep); err != nil {
		t.Fatal(err)
	}
	doc, _, _ = readDesktopJSON(config)
	if !reflect.DeepEqual(initial, doc) {
		t.Fatalf("original configuration lost: %v", doc)
	}
	if _, err = os.Stat(profile); !os.IsNotExist(err) {
		t.Fatal("owned profile retained", err)
	}
	if err := restoreDesktopGatewayAt(threep); err != nil {
		t.Fatal("restore must be idempotent", err)
	}
}

func TestDesktopGatewayPreservesLaterUserChanges(t *testing.T) {
	root := t.TempDir()
	normal, threep := filepath.Join(root, "Claude"), filepath.Join(root, "Claude-3p")
	if err := injectDesktopGatewayAt(normal, threep, "https://example.test/api/gateway", "gfa-key", nil); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(normal, "claude_desktop_config.json")
	doc, _, _ := readDesktopJSON(path)
	doc["deploymentMode"] = "user-choice"
	doc["other"] = true
	if err := writeDesktopJSON(path, doc); err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(threep, "configLibrary", "_meta.json")
	meta, _, _ := readDesktopJSON(metaPath)
	meta["entries"] = append(meta["entries"].([]interface{}), map[string]interface{}{"id": "another", "name": "Another"})
	meta["appliedId"] = "another"
	if err := writeDesktopJSON(metaPath, meta); err != nil {
		t.Fatal(err)
	}
	if err := restoreDesktopGatewayAt(threep); err != nil {
		t.Fatal(err)
	}
	after, _, _ := readDesktopJSON(path)
	if !reflect.DeepEqual(doc, after) {
		t.Fatal("overwrote user change")
	}
	meta, _, _ = readDesktopJSON(metaPath)
	if meta["appliedId"] != "another" || desktopEntriesContain(meta["entries"], desktopGatewayProfileID) || !desktopEntriesContain(meta["entries"], "another") {
		t.Fatal("profile selection corrupted")
	}
	mode, _, _ := readDesktopJSON(filepath.Join(threep, "claude_desktop_config.json"))
	if mode["deploymentMode"] != "3p" {
		t.Fatal("disabled the user's newly selected third-party profile")
	}
}

func TestDesktopWindowsConfigSelection(t *testing.T) {
	root := t.TempDir()
	versioned := filepath.Join(root, "Claude_company")
	if err := os.Mkdir(versioned, 0700); err != nil {
		t.Fatal(err)
	}
	got, err := desktopWindowsConfigDir(root, "Claude")
	if err != nil || got != versioned {
		t.Fatal(got, err)
	}
	if err := os.Mkdir(filepath.Join(root, "Claude_other"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := desktopWindowsConfigDir(root, "Claude"); err == nil {
		t.Fatal("ambiguous directories must not be guessed")
	}
	exact := filepath.Join(root, "Claude")
	if err := os.Mkdir(exact, 0700); err != nil {
		t.Fatal(err)
	}
	got, err = desktopWindowsConfigDir(root, "Claude")
	if err != nil || got != exact {
		t.Fatal(got, err)
	}
}

func TestDesktopGatewayRejectsMalformedConfigBeforeWriting(t *testing.T) {
	for _, invalid := range []string{"{", "null", "[]"} {
		t.Run(invalid, func(t *testing.T) {
			root := t.TempDir()
			normal, threep := filepath.Join(root, "Claude"), filepath.Join(root, "Claude-3p")
			if err := os.MkdirAll(normal, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(normal, "claude_desktop_config.json")
			if err := os.WriteFile(path, []byte(invalid), 0600); err != nil {
				t.Fatal(err)
			}
			if err := injectDesktopGatewayAt(normal, threep, "https://example.test", "gfa-key", nil); err == nil {
				t.Fatal("accepted malformed JSON")
			}
			if _, err := os.Stat(threep); !os.IsNotExist(err) {
				t.Fatal("partial installation despite preflight failure")
			}
			b, _ := os.ReadFile(path)
			if string(b) != invalid {
				t.Fatal("modified original")
			}
		})
	}
}

func TestDesktopGatewayInterruptedWriteCanRestore(t *testing.T) {
	root := t.TempDir()
	normal, threep := filepath.Join(root, "Claude"), filepath.Join(root, "Claude-3p")
	if err := injectDesktopGatewayAt(normal, threep, "https://example.test", "gfa-key", nil); err != nil {
		t.Fatal(err)
	}
	// Simulate an interruption before the mode switches: only profile and metadata remain.
	for _, dir := range []string{normal, threep} {
		if err := os.Remove(filepath.Join(dir, "claude_desktop_config.json")); err != nil {
			t.Fatal(err)
		}
	}
	if err := restoreDesktopGatewayAt(threep); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(threep, "configLibrary", desktopGatewayProfileID+".json")); !os.IsNotExist(err) {
		t.Fatal("profile not rolled back")
	}
}

func TestDesktopGatewaySealedKeyRemainsManagedAndRestores(t *testing.T) {
	root := t.TempDir()
	normal, threep := filepath.Join(root, "Claude"), filepath.Join(root, "Claude-3p")
	base := "https://gateway.test/api/gateway"
	if err := injectDesktopGatewayAt(normal, threep, base, "gfa-fixture", nil); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(threep, "configLibrary", desktopGatewayProfileID+".json")
	doc, _, err := readDesktopJSON(profile)
	if err != nil {
		t.Fatal(err)
	}
	doc["inferenceGatewayApiKey"] = "__sealed__:v1:fixture-encrypted-by-desktop"
	if err := writeDesktopJSON(profile, doc); err != nil {
		t.Fatal(err)
	}
	if !isDesktopGatewayInjectedAt(normal, threep, base) {
		t.Fatal("Desktop key sealing lost takeover status")
	}
	if err := restoreDesktopGatewayAt(threep); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(profile); !os.IsNotExist(err) {
		t.Fatal("GFA encrypted key/profile was left behind")
	}
	if isDesktopGatewayInjectedAt(normal, threep, base) {
		t.Fatal("restored profile still appears managed")
	}
}
