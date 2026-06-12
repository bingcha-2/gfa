package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	goruntime "runtime"
	"strings"
	"time"
)

// authBaseURL is the base URL for account-login API calls.
// Set via BCAI_AUTH_BASE env; defaults to https://bcai.lol/api.
// Overridable in tests.
var authBaseURL = getEnvOrDefault("BCAI_AUTH_BASE", "https://bcai.lol/api")

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

// loginRequest is the payload for POST /app/login.
type loginRequest struct {
	Email         string `json:"email"`
	Password      string `json:"password"`
	DeviceId      string `json:"deviceId"`
	DeviceName    string `json:"deviceName"`
	ClientVersion string `json:"clientVersion"`
	Platform      string `json:"platform"`
}

// loginResponse mirrors the success shape of POST /app/login.
type loginResponse struct {
	Token          string `json:"token"`
	TokenExpiresAt string `json:"tokenExpiresAt"`
	Account        struct {
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
	} `json:"account"`
	Subscription *struct {
		PlanName    string   `json:"planName"`
		Status      string   `json:"status"`
		ExpiresAt   string   `json:"expiresAt"`
		DeviceLimit int      `json:"deviceLimit"`
		Products    []string `json:"products"`
	} `json:"subscription"`
}

// loginErrorResponse is the error shape of POST /app/login.
type loginErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// doAuthPost posts JSON to the auth endpoint with host fallback (primary → fallback).
// It does NOT add an Authorization header (used for /app/login itself).
func doAuthPost(path string, payload interface{}) ([]byte, int, error) {
	base := authBaseURL
	// Use the same bcaiURLCandidates host-fallback logic as other calls.
	var lastErr error
	for _, candidate := range bcaiURLCandidates(base) {
		body, status, err := postJSONWithSecretToBase(candidate, createBcaiClient(), path, payload, "")
		if err == nil {
			return body, status, nil
		}
		Log("[auth] direct failed for %s: %v; trying proxy", candidate, err)
		body, status, err = postJSONWithSecretToBase(candidate, createHttpClient(""), path, payload, "")
		if err == nil {
			return body, status, nil
		}
		Log("[auth] proxy also failed for %s: %v", candidate, err)
		lastErr = err
	}
	return nil, 0, lastErr
}

// doAuthPostWithBearer posts JSON with a Bearer token for authenticated endpoints.
func doAuthPostWithBearer(path string, payload interface{}, token string) ([]byte, int, error) {
	base := authBaseURL
	var lastErr error
	for _, candidate := range bcaiURLCandidates(base) {
		body, status, err := postJSONWithSecretToBase(candidate, createBcaiClient(), path, payload, token)
		if err == nil {
			return body, status, nil
		}
		body, status, err = postJSONWithSecretToBase(candidate, createHttpClient(""), path, payload, token)
		if err == nil {
			return body, status, nil
		}
		lastErr = err
	}
	return nil, 0, lastErr
}

// osHostname is a thin wrapper around os.Hostname, overridable in tests.
var osHostname = func() (string, error) {
	return os.Hostname()
}

// computeDeviceName builds a human-readable device name: hostname + " (" + GOOS + ")".
func computeDeviceName() string {
	hostname := "unknown"
	if h, err := osHostname(); err == nil && h != "" {
		hostname = h
	}
	return fmt.Sprintf("%s (%s)", hostname, goruntime.GOOS)
}

// startServicesForUser starts leaser + proxy after a successful login.
func startServicesForUser(cfg Config) {
	// Use UserToken as the "card" parameter throughout the lease/proxy chain;
	// leaser passes it to postJSONWithSecretToBase which now sets Bearer.
	token := cfg.UserToken
	deviceId := cfg.DeviceId

	// Start auto-lease (antigravity path). Session accounts lease directly with
	// the JWT — the old card /api/activate handshake is gone (server stubbed it
	// fail-closed after the force-upgrade; products now arrive with each lease
	// response's accessKeyStatus).
	GetLeaser().StartAutoLease(token, deviceId, "")

	// HTTP proxy always starts.
	if err := GetHTTPProxy().Start(cfg.ProxyPort, token, deviceId, ""); err != nil {
		Log("[auth] HTTP proxy start failed: %v", err)
	}

	// MITM proxy.
	if err := GetMitmManager().StartProxy(mitmDefaultPort, token, deviceId, ""); err != nil {
		Log("[auth] MITM proxy start failed: %v", err)
	}
}

// stopServicesForUser stops leaser + proxy (used by logout).
// The MITM proxy keeps listening on its fixed port (an active Claude Desktop
// takeover still routes traffic through it), but its session token must be
// cleared — the same UpdateConfig sync app.go's SaveConfig does on config
// change — otherwise it would keep leasing with the stale token after logout.
// On the next login, startServicesForUser's StartProxy re-arms it (StartProxy
// on an already-running proxy just refreshes card/deviceId/upstream).
func stopServicesForUser() {
	GetLeaser().StopAutoLease()
	GetHTTPProxy().Stop()
	GetMitmManager().UpdateConfig("", LoadConfig().DeviceId, "")
}

// ────────────────────────────────────────────────────────────────────────────
// Exported App methods (bound to Wails)
// ────────────────────────────────────────────────────────────────────────────

// clearUserSession zeroes the account-session fields on cfg.
// DeviceName (and DeviceId) are intentionally kept — they are device identity,
// not session state, and must survive logout/revocation for the next login.
func clearUserSession(cfg *Config) {
	cfg.UserToken = ""
	cfg.UserTokenExpiry = ""
	cfg.UserEmail = ""
	cfg.PlanName = ""
	cfg.PlanExpiry = ""
	cfg.PlanDeviceMax = 0
}

// UserLogin authenticates with email+password, persists session data to config,
// and starts leaser/proxy services.
func (a *App) UserLogin(email, password string) (map[string]interface{}, error) {
	// Serialize with SaveConfig/RestartProxy/UserLogout/HeartbeatCheck — config
	// writes and service lifecycle must not interleave. The lock is taken at
	// the outermost App-method layer only (start/stopServicesForUser don't lock).
	a.lock.Lock()
	defer a.lock.Unlock()

	cfg := LoadConfig()

	deviceName := cfg.DeviceName
	if deviceName == "" {
		deviceName = computeDeviceName()
	}

	req := loginRequest{
		Email:         email,
		Password:      password,
		DeviceId:      cfg.DeviceId,
		DeviceName:    deviceName,
		ClientVersion: AppVersion,
		Platform:      goruntime.GOOS,
	}

	Log("[auth] Logging in: email=%s deviceId=%s", email, cfg.DeviceId)

	body, status, err := doAuthPost("/app/login", req)
	if err != nil {
		return nil, fmt.Errorf("login network error: %w", err)
	}

	// Handle error responses.
	if status != http.StatusOK {
		var errResp loginErrorResponse
		if jsonErr := json.Unmarshal(body, &errResp); jsonErr == nil && errResp.Error != "" {
			return nil, fmt.Errorf("%s: %s", errResp.Error, errResp.Message)
		}
		return nil, fmt.Errorf("login failed (HTTP %d): %s", status, string(body))
	}

	// Parse success response.
	var resp loginResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("login response parse error: %w", err)
	}
	if resp.Token == "" {
		return nil, fmt.Errorf("login response missing token")
	}

	// Persist to config atomically.
	cfg.UserToken = resp.Token
	cfg.UserTokenExpiry = resp.TokenExpiresAt
	cfg.UserEmail = resp.Account.Email
	cfg.DeviceName = deviceName
	if resp.Subscription != nil {
		cfg.PlanName = resp.Subscription.PlanName
		cfg.PlanExpiry = resp.Subscription.ExpiresAt
		cfg.PlanDeviceMax = resp.Subscription.DeviceLimit
	}
	if err := SaveConfig(cfg); err != nil {
		Log("[auth] Failed to save config after login: %v", err)
		// Non-fatal — session is valid; continue.
	}

	Log("[auth] Login OK: email=%s token=%s... plan=%s", resp.Account.Email, resp.Token[:min(8, len(resp.Token))], cfg.PlanName)

	// Start services with the new token.
	startServicesForUser(cfg)

	result := map[string]interface{}{
		"email":       resp.Account.Email,
		"displayName": resp.Account.DisplayName,
		"planName":    cfg.PlanName,
		"planExpiry":  cfg.PlanExpiry,
	}
	return result, nil
}

// UserLogout sends a best-effort logout to the server, clears config, stops services.
func (a *App) UserLogout() error {
	// Same serialization as UserLogin — see comment there.
	a.lock.Lock()
	defer a.lock.Unlock()

	cfg := LoadConfig()
	token := cfg.UserToken
	deviceId := cfg.DeviceId

	// Best-effort POST /app/logout.
	if token != "" {
		payload := map[string]string{"deviceId": deviceId}
		body, status, err := doAuthPostWithBearer("/app/logout", payload, token)
		if err != nil {
			Log("[auth] Logout network error (non-fatal): %v", err)
		} else {
			Log("[auth] Logout response: status=%d body=%s", status, string(body))
		}
	}

	// Stop services.
	stopServicesForUser()

	// Clear account-session fields from config (DeviceName is intentionally
	// kept — it's device identity, not session state).
	clearUserSession(&cfg)
	if err := SaveConfig(cfg); err != nil {
		Log("[auth] Failed to clear config on logout: %v", err)
		return err
	}
	Log("[auth] Logged out, config cleared")
	return nil
}

// GetAccountState returns config-derived account/plan/device state for the UI.
// Returns a map with loggedIn bool and all account fields.
func (a *App) GetAccountState() map[string]interface{} {
	cfg := LoadConfig()

	loggedIn := cfg.UserToken != ""

	// Determine if the token appears expired.
	tokenExpired := false
	if loggedIn && cfg.UserTokenExpiry != "" {
		if t, err := time.Parse(time.RFC3339, cfg.UserTokenExpiry); err == nil {
			tokenExpired = time.Now().After(t)
		}
	}

	return map[string]interface{}{
		"loggedIn":      loggedIn,
		"email":         cfg.UserEmail,
		"planName":      cfg.PlanName,
		"planExpiry":    cfg.PlanExpiry,
		"planDeviceMax": cfg.PlanDeviceMax,
		"deviceName":    cfg.DeviceName,
		"tokenExpiry":   cfg.UserTokenExpiry,
		"tokenExpired":  tokenExpired,
		// cardUnusable-equivalent: token expired or empty
		"sessionUnusable": !loggedIn || tokenExpired,
	}
}

// min returns the smaller of a, b (local helper to avoid Go 1.21 requirement).
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// HeartbeatCheck sends a heartbeat to the server (frontend polls ~60s),
// persists refreshed subscription info, and handles fatal session classes:
//   - SESSION_INVALID / DEVICE_REVOKED / DEVICE_LIMIT_EXCEEDED → the session is
//     dead server-side: stop services and clear the local session so the UI
//     lands on the login page (via GetAccountState).
//   - SUBSCRIPTION_EXPIRED → still authenticated, but the plan lapsed: keep the
//     session, mark the leaser card-unusable (drives the dashboard banner) and
//     stop auto-lease.
//
// Transient network errors return an error WITHOUT touching local state — a
// flaky network must never log the user out.
func (a *App) HeartbeatCheck() (map[string]interface{}, error) {
	// Mutates config + service lifecycle on fatal classes → same outermost
	// App-method serialization as UserLogin/UserLogout/SaveConfig.
	a.lock.Lock()
	defer a.lock.Unlock()

	cfg := LoadConfig()
	if cfg.UserToken == "" {
		return nil, fmt.Errorf("not logged in")
	}

	payload := map[string]interface{}{
		"deviceId":      cfg.DeviceId,
		"clientVersion": AppVersion,
	}

	body, status, err := doAuthPostWithBearer("/app/heartbeat", payload, cfg.UserToken)
	if err != nil {
		// Network failure — keep the session untouched, only surface the error.
		return nil, fmt.Errorf("heartbeat network error: %w", err)
	}

	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		var errResp loginErrorResponse
		if jsonErr := json.Unmarshal(body, &errResp); jsonErr == nil && errResp.Error != "" {
			switch errCode := strings.ToUpper(errResp.Error); errCode {
			case "SESSION_INVALID", "DEVICE_REVOKED", "DEVICE_LIMIT_EXCEEDED":
				// Forced local logout (no server POST — the token is already dead).
				Log("[auth] Heartbeat fatal (%s): clearing local session", errCode)
				stopServicesForUser()
				clearUserSession(&cfg)
				if saveErr := SaveConfig(cfg); saveErr != nil {
					Log("[auth] Failed to clear session after %s: %v", errCode, saveErr)
				}
				return nil, fmt.Errorf("%s", errCode)
			case "SUBSCRIPTION_EXPIRED":
				// Keep the session; stop leasing and raise the dashboard banner
				// (existing cardUnusable mechanism).
				Log("[auth] Heartbeat: subscription expired — marking card unusable")
				GetLeaser().markCardUnusable(fmt.Errorf("SUBSCRIPTION_EXPIRED"))
				return nil, fmt.Errorf("%s", errCode)
			}
		}
		return nil, fmt.Errorf("heartbeat failed (HTTP %d): %s", status, string(body))
	}

	if status != http.StatusOK {
		return nil, fmt.Errorf("heartbeat failed (HTTP %d): %s", status, string(body))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("heartbeat parse error: %w", err)
	}

	// Refresh the local subscription snapshot so plan renewals/changes show up
	// in the UI (GetAccountState reads config) without a re-login.
	if sub, ok := result["subscription"].(map[string]interface{}); ok {
		changed := false
		if v, ok := sub["planName"].(string); ok && v != cfg.PlanName {
			cfg.PlanName = v
			changed = true
		}
		if v, ok := sub["expiresAt"].(string); ok && v != cfg.PlanExpiry {
			cfg.PlanExpiry = v
			changed = true
		}
		if v, ok := sub["deviceLimit"].(float64); ok && int(v) != cfg.PlanDeviceMax {
			cfg.PlanDeviceMax = int(v)
			changed = true
		}
		if changed {
			if saveErr := SaveConfig(cfg); saveErr != nil {
				Log("[auth] Failed to persist heartbeat subscription update: %v", saveErr)
			}
		}
	}
	return result, nil
}
