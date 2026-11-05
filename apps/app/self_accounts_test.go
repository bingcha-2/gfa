package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testSelfAccountAuth() []byte {
	return []byte(`{"auth_mode":"chatgpt","tokens":{"id_token":"id-token","access_token":"access-token","refresh_token":"refresh-token","account_id":"account-123"}}`)
}

func testSelfAccountAuthFor(accountID, accessToken string) []byte {
	return []byte(`{"auth_mode":"chatgpt","tokens":{"id_token":"id-token","access_token":"` + accessToken + `","refresh_token":"refresh-token","account_id":"` + accountID + `"}}`)
}

func useSelfAccountTestDirs(t *testing.T) (string, string) {
	t.Helper()
	previousConfigDir := origConfigDir
	appDataDir := t.TempDir()
	codexDir := t.TempDir()
	origConfigDir = appDataDir
	t.Cleanup(func() { origConfigDir = previousConfigDir })
	t.Setenv("CODEX_HOME", codexDir)
	return appDataDir, codexDir
}

func TestSelfAccountViewDoesNotExposeCredentials(t *testing.T) {
	view := selfAccountView(selfAccountRecord{
		ID: "local-1", Email: "owner@example.com", AccountID: "account-123", Auth: testSelfAccountAuth(),
	}, "local-1")
	if _, exposed := view["auth"]; exposed {
		t.Fatal("self account view must not expose auth data to the frontend")
	}
	encoded, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) == "" || json.Valid(encoded) == false {
		t.Fatalf("invalid account view JSON: %q", encoded)
	}
}

func TestSelfAccountSyncClearsStaleActiveAccount(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	vault := defaultSelfAccountVault()
	vault.ActiveID = "previous-account"
	vault.Accounts = append(vault.Accounts, selfAccountRecord{ID: "previous-account", Auth: testSelfAccountAuth()})

	if _, err := syncCurrentSelfAccount(vault); err != nil {
		t.Fatal(err)
	}
	if vault.ActiveID != "" {
		t.Fatalf("active account = %q, want empty when Codex has no OAuth login", vault.ActiveID)
	}
}

func TestSelfAccountQuotaUsesStoredAccountLocally(t *testing.T) {
	var authorization, accountID, requestedURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		accountID = r.Header.Get("ChatGPT-Account-Id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"plan_type":"plus",
			"rate_limit":{
				"primary_window":{"used_percent":80,"limit_window_seconds":18000,"reset_at":1893456000},
				"secondary_window":{"used_percent":12.5,"limit_window_seconds":604800,"reset_at":1893888000}
			}
		}`))
	}))
	defer server.Close()

	previousDo := selfAccountQuotaDo
	selfAccountQuotaDo = func(req *http.Request) (*http.Response, error) {
		requestedURL = req.URL.String()
		clone := req.Clone(req.Context())
		clone.URL, _ = url.Parse(server.URL)
		return server.Client().Do(clone)
	}
	t.Cleanup(func() { selfAccountQuotaDo = previousDo })

	record := selfAccountRecord{Auth: testSelfAccountAuth()}
	quota, err := fetchSelfAccountQuota(&record)
	if err != nil {
		t.Fatal(err)
	}
	if authorization != "Bearer access-token" || accountID != "account-123" {
		t.Fatalf("unexpected usage request headers: authorization=%q account=%q", authorization, accountID)
	}
	if requestedURL != selfAccountQuotaURL {
		t.Fatalf("usage URL = %q, want fixed official endpoint %q", requestedURL, selfAccountQuotaURL)
	}
	if record.PlanType != "plus" {
		t.Fatalf("plan type = %q, want plus", record.PlanType)
	}
	if quota.FiveHour == nil || quota.FiveHour.Remaining != 20 || !quota.FiveHour.Known {
		t.Fatalf("five hour quota = %#v, want known 20%%", quota.FiveHour)
	}
	if quota.Weekly == nil || quota.Weekly.Remaining != 88 || !quota.Weekly.Known {
		t.Fatalf("weekly quota = %#v, want known 88%%", quota.Weekly)
	}
}

func TestPersistCurrentSelfAccountBeforeSwitchSavesUnknownCurrentLogin(t *testing.T) {
	_, codexDir := useSelfAccountTestDirs(t)
	targetIdentity, ok := parseCodexOAuthIdentity(testSelfAccountAuthFor("target-account", "target-token"))
	if !ok {
		t.Fatal("target test identity is invalid")
	}
	vault := defaultSelfAccountVault()
	upsertSelfAccount(vault, targetIdentity, "target", false)
	if err := saveSelfAccountVault(vault); err != nil {
		t.Fatal(err)
	}
	currentAuth := testSelfAccountAuthFor("current-account", "current-new-token")
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), currentAuth, 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := loadSelfAccountVault()
	if err != nil {
		t.Fatal(err)
	}
	if err := persistCurrentSelfAccountBeforeSwitch(loaded); err != nil {
		t.Fatal(err)
	}
	saved, err := loadSelfAccountVault()
	if err != nil {
		t.Fatal(err)
	}
	currentIdentity, _ := parseCodexOAuthIdentity(currentAuth)
	idx := selfAccountIndex(saved, selfAccountID(currentIdentity))
	if idx < 0 {
		t.Fatal("current login was not inserted before switching")
	}
	if saved.ActiveID != saved.Accounts[idx].ID || !strings.Contains(string(saved.Accounts[idx].Auth), "current-new-token") {
		t.Fatalf("current login was not durably refreshed: active=%q record=%#v", saved.ActiveID, saved.Accounts[idx])
	}
}

func TestSwitchSelfAccountPersistsCurrentThenProjectsTarget(t *testing.T) {
	_, codexDir := useSelfAccountTestDirs(t)
	currentAuth := testSelfAccountAuthFor("current-account", "current-new-token")
	targetAuth := testSelfAccountAuthFor("target-account", "target-token")
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), currentAuth, 0o600); err != nil {
		t.Fatal(err)
	}
	targetIdentity, ok := parseCodexOAuthIdentity(targetAuth)
	if !ok {
		t.Fatal("target test identity is invalid")
	}
	vault := defaultSelfAccountVault()
	target := upsertSelfAccount(vault, targetIdentity, "target", false)
	if err := saveSelfAccountVault(vault); err != nil {
		t.Fatal(err)
	}

	result, err := (&App{}).SwitchSelfAccount(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result["reloadMode"] != "not_running" {
		t.Fatalf("reload mode = %v, want not_running in tests", result["reloadMode"])
	}
	live, err := os.ReadFile(filepath.Join(codexDir, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	projected, ok := parseCodexOAuthIdentity(live)
	if !ok || projected.AccountID != "target-account" {
		t.Fatalf("live identity = %#v, want target account", projected)
	}
	saved, err := loadSelfAccountVault()
	if err != nil {
		t.Fatal(err)
	}
	currentIdentity, _ := parseCodexOAuthIdentity(currentAuth)
	if selfAccountIndex(saved, selfAccountID(currentIdentity)) < 0 {
		t.Fatal("current account was not saved before target projection")
	}
	if saved.ActiveID != target.ID {
		t.Fatalf("active account = %q, want target %q", saved.ActiveID, target.ID)
	}
}

func TestRestoreSelfAccountLiveBackupReportsFailure(t *testing.T) {
	root := t.TempDir()
	blockedHome := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(blockedHome, []byte("blocked"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", blockedHome)
	err := restoreSelfAccountLiveBackup(selfAccountLiveBackup{file: testSelfAccountAuth(), fileExists: true})
	if err == nil || !strings.Contains(err.Error(), "恢复 auth.json 失败") {
		t.Fatalf("rollback error = %v, want explicit auth.json restore failure", err)
	}
}

func TestHasCodexTakeoverArtifactsDetectsDriftedProviderTable(t *testing.T) {
	_, codexDir := useSelfAccountTestDirs(t)
	if hasCodexTakeoverArtifacts() {
		t.Fatal("empty Codex home should not be treated as managed")
	}
	config := `[model_providers.bingchaai]
name = "stale managed provider"
base_url = "http://127.0.0.1:1/v1"
`
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if !hasCodexTakeoverArtifacts() {
		t.Fatal("drifted GFA provider table should still stop takeover before account switching")
	}
}

func TestSelfAccountVaultKeyTightensPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file permissions are not enforced on Windows")
	}
	appDataDir, _ := useSelfAccountTestDirs(t)
	key := make([]byte, 32)
	path := filepath.Join(appDataDir, "self-accounts.key")
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(key)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := selfAccountVaultKey(false); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key permissions = %o, want 600", info.Mode().Perm())
	}
}
