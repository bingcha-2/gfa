package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── Helpers ──────────────────────────────────────────────────────────────────

// newLoginServer returns a test HTTP server that handles /app/login.
// onRequest is called with the decoded request body so callers can assert it.
func newLoginServer(t *testing.T, resp interface{}, statusCode int, onRequest func(body map[string]interface{})) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/app/login" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected JSON content-type, got %s", r.Header.Get("Content-Type"))
		}
		if onRequest != nil {
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			onRequest(body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		_ = json.NewEncoder(w).Encode(resp)
	}))
}

// ── TestUserLogin_Success ────────────────────────────────────────────────────

// TestUserLogin_Success verifies that a successful login:
//   - calls /app/login with the expected fields
//   - persists UserToken, UserEmail, PlanName, UserTokenExpiry to config
//   - returns the account map with email + displayName.
func TestUserLogin_Success(t *testing.T) {
	// Point to a temp config dir so we don't pollute real state.
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()

	// Stub the BCAI_AUTH_BASE env so the client talks to our httptest server.
	expiresAt := time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	loginResp := map[string]interface{}{
		"token":          "tok-abc123",
		"tokenExpiresAt": expiresAt,
		"account": map[string]interface{}{
			"email":       "user@example.com",
			"displayName": "Test User",
		},
		"subscription": map[string]interface{}{
			"planName":    "Pro",
			"status":      "active",
			"expiresAt":   expiresAt,
			"deviceLimit": 3,
			"products":    []string{"antigravity"},
		},
	}

	var capturedBody map[string]interface{}
	srv := newLoginServer(t, loginResp, http.StatusOK, func(b map[string]interface{}) {
		capturedBody = b
	})
	defer srv.Close()

	origAuthBase := authBaseURL
	authBaseURL = srv.URL
	defer func() { authBaseURL = origAuthBase }()

	app := &App{}
	result, err := app.UserLogin("user@example.com", "secret-pass")
	if err != nil {
		t.Fatalf("UserLogin returned error: %v", err)
	}

	// Verify fields sent to server.
	if capturedBody["email"] != "user@example.com" {
		t.Errorf("email not forwarded, got %v", capturedBody["email"])
	}
	if capturedBody["password"] != "secret-pass" {
		t.Errorf("password not forwarded")
	}
	if _, ok := capturedBody["deviceId"]; !ok {
		t.Errorf("deviceId missing from request")
	}
	if _, ok := capturedBody["deviceName"]; !ok {
		t.Errorf("deviceName missing from request")
	}

	// Verify return value.
	if result["email"] != "user@example.com" {
		t.Errorf("result email wrong: %v", result["email"])
	}

	// Verify config was persisted.
	cfg := LoadConfig()
	if cfg.UserToken != "tok-abc123" {
		t.Errorf("UserToken not persisted, got %q", cfg.UserToken)
	}
	if cfg.UserEmail != "user@example.com" {
		t.Errorf("UserEmail not persisted, got %q", cfg.UserEmail)
	}
	if cfg.PlanName != "Pro" {
		t.Errorf("PlanName not persisted, got %q", cfg.PlanName)
	}
	if cfg.UserTokenExpiry != expiresAt {
		t.Errorf("UserTokenExpiry not persisted, got %q", cfg.UserTokenExpiry)
	}
}

// ── TestUserLogin_DeviceLimitExceeded ────────────────────────────────────────

func TestUserLogin_DeviceLimitExceeded(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()

	errResp := map[string]interface{}{
		"error":   "DEVICE_LIMIT_EXCEEDED",
		"message": "Device limit reached",
	}
	srv := newLoginServer(t, errResp, http.StatusForbidden, nil)
	defer srv.Close()

	origAuthBase := authBaseURL
	authBaseURL = srv.URL
	defer func() { authBaseURL = origAuthBase }()

	app := &App{}
	_, err := app.UserLogin("user@example.com", "pass")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "DEVICE_LIMIT_EXCEEDED") {
		t.Errorf("expected DEVICE_LIMIT_EXCEEDED in error, got %q", err.Error())
	}
}

// ── TestUserLogin_InvalidCredentials ────────────────────────────────────────

func TestUserLogin_InvalidCredentials(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()

	errResp := map[string]interface{}{
		"error":   "INVALID_CREDENTIALS",
		"message": "Bad credentials",
	}
	srv := newLoginServer(t, errResp, http.StatusUnauthorized, nil)
	defer srv.Close()

	origAuthBase := authBaseURL
	authBaseURL = srv.URL
	defer func() { authBaseURL = origAuthBase }()

	app := &App{}
	_, err := app.UserLogin("user@example.com", "wrong")
	if err == nil {
		t.Fatal("expected error for invalid credentials")
	}
}

// ── TestPostJSONWithSecretToBase_Bearer ──────────────────────────────────────

// TestPostJSONWithSecretToBase_Bearer asserts that the new auth mechanic
// sends Authorization: Bearer and does NOT send x-token-server-secret.
func TestPostJSONWithSecretToBase_Bearer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/lease-token" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		// NEW: must have Bearer auth
		authHeader := r.Header.Get("Authorization")
		if authHeader != "Bearer user-token-xyz" {
			t.Errorf("Authorization header = %q, want %q", authHeader, "Bearer user-token-xyz")
		}
		// NEW: must NOT have old secret header
		if got := r.Header.Get("x-token-server-secret"); got != "" {
			t.Errorf("x-token-server-secret should be absent, got %q", got)
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["clientId"] != "device-b" {
			t.Fatalf("clientId = %q", payload["clientId"])
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	defer srv.Close()

	body, status, err := postJSONWithSecretToBase(srv.URL, srv.Client(), "/lease-token", map[string]string{
		"clientId": "device-b",
	}, "user-token-xyz")
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if string(body) == "" {
		t.Fatal("expected response body")
	}
}

// ── TestHeartbeat_SessionInvalid_FatalPath ────────────────────────────────────

func TestHeartbeat_SessionInvalid_FatalPath(t *testing.T) {
	// SESSION_INVALID should be treated as a card-fatal error
	if !isCardFatalError("SESSION_INVALID") {
		t.Error("SESSION_INVALID should be a card-fatal error")
	}
	if !isCardFatalError("session_invalid") {
		t.Error("session_invalid (lowercase) should be a card-fatal error")
	}
	if !isCardFatalError("SUBSCRIPTION_EXPIRED") {
		t.Error("SUBSCRIPTION_EXPIRED should be a card-fatal error")
	}
	if !isCardFatalError("DEVICE_REVOKED") {
		t.Error("DEVICE_REVOKED should be a card-fatal error")
	}
	if !isCardFatalError("DEVICE_LIMIT_EXCEEDED") {
		t.Error("DEVICE_LIMIT_EXCEEDED should be a card-fatal error")
	}
	// Non-fatal should still not be fatal
	if isCardFatalError("pool busy") {
		t.Error("pool busy should not be a card-fatal error")
	}
	if isCardFatalError("rate limited") {
		t.Error("rate limited should not be a card-fatal error")
	}
}

// ── TestGetAccountState ───────────────────────────────────────────────────────

func TestGetAccountState(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()

	// Write a config with user account data
	cfg := DefaultConfig()
	cfg.UserToken = "some-token"
	cfg.UserEmail = "test@bcai.lol"
	cfg.PlanName = "Business"
	cfg.DeviceName = "TestMachine (linux)"
	cfg.PlanExpiry = time.Now().Add(60 * 24 * time.Hour).UTC().Format(time.RFC3339)
	if err := SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	app := &App{}
	state := app.GetAccountState()

	if state["loggedIn"] != true {
		t.Errorf("expected loggedIn=true, got %v", state["loggedIn"])
	}
	if state["email"] != "test@bcai.lol" {
		t.Errorf("email mismatch: %v", state["email"])
	}
	if state["planName"] != "Business" {
		t.Errorf("planName mismatch: %v", state["planName"])
	}
	if state["deviceName"] != "TestMachine (linux)" {
		t.Errorf("deviceName mismatch: %v", state["deviceName"])
	}
}

func TestGetAccountState_LoggedOut(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()

	app := &App{}
	state := app.GetAccountState()

	if state["loggedIn"] != false {
		t.Errorf("expected loggedIn=false for fresh config, got %v", state["loggedIn"])
	}
}

// ── TestConfigFilePath_Override ──────────────────────────────────────────────

// Ensure origConfigDir override works correctly in tests.
func TestConfigFilePath_Override(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()

	expected := filepath.Join(tmpDir, "config.json")
	if got := configFilePath(); got != expected {
		t.Errorf("configFilePath() = %q, want %q", got, expected)
	}
}

// ── TestLegacyConfigLoadsAccountCard ─────────────────────────────────────────

// Old config files that still have accountCard should load without error.
func TestLegacyConfigLoadsAccountCard(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()

	legacyJSON := []byte(`{"accountCard":"AIBC-1234","deviceId":"dev-abc","proxyPort":48800}`)
	if err := os.WriteFile(filepath.Join(tmpDir, "config.json"), legacyJSON, 0600); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig()
	// Legacy field should still be there
	if cfg.AccountCard != "AIBC-1234" {
		t.Errorf("AccountCard = %q, want %q", cfg.AccountCard, "AIBC-1234")
	}
	// New fields should be zero values
	if cfg.UserToken != "" {
		t.Errorf("UserToken should be empty for legacy config, got %q", cfg.UserToken)
	}
}
