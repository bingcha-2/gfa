package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	goruntime "runtime"
	"strings"
	"time"
)

// authBaseURL is the machine-API base URL for account-session calls
// (/app/login, /app/heartbeat, /app/logout) and other client API fetches.
// Set via BCAI_AUTH_BASE env or buildAPIBase ldflags. Overridable in tests.
var authBaseURL = getEnvOrDefault("BCAI_AUTH_BASE", buildAPIBase+"/api")

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
	// Subscriptions 是全部生效订阅(服务端按 priority 升序),驱动客户端多订阅展示。
	Subscriptions []struct {
		Id             string   `json:"id"`
		Status         string   `json:"status"`
		ExpiresAt      string   `json:"expiresAt"`
		DeviceLimit    int      `json:"deviceLimit"`
		Priority       int      `json:"priority"`
		Products       []string `json:"products"`
		RemainFraction *float64 `json:"remainFraction"`
	} `json:"subscriptions"`
}

// snapshots 把 /app/login 响应的订阅数组转成可持久化快照(供多订阅展示)。
func (r loginResponse) snapshots() []SubscriptionSnapshot {
	out := make([]SubscriptionSnapshot, 0, len(r.Subscriptions))
	for _, s := range r.Subscriptions {
		out = append(out, SubscriptionSnapshot{
			Id:             s.Id,
			Status:         s.Status,
			ExpiresAt:      s.ExpiresAt,
			DeviceLimit:    s.DeviceLimit,
			Priority:       s.Priority,
			Products:       s.Products,
			RemainFraction: s.RemainFraction,
		})
	}
	return out
}

// loginErrorResponse is the error shape of POST /app/login.
type loginErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// doAuthPost posts JSON to the auth endpoint (direct, then proxy fallback —
// transport-level resilience only; there is no alternate-host fallback).
// It does NOT add an Authorization header (used for /app/login itself).
func doAuthPost(path string, payload interface{}) ([]byte, int, error) {
	body, status, err := postJSONWithSecretToBase(authBaseURL, createBcaiClient(), path, payload, "")
	if err == nil {
		return body, status, nil
	}
	Log("[auth] direct failed for %s: %v; trying proxy", authBaseURL, err)
	body, status, err = postJSONWithSecretToBase(authBaseURL, createHttpClient(""), path, payload, "")
	if err == nil {
		return body, status, nil
	}
	Log("[auth] proxy also failed for %s: %v", authBaseURL, err)
	return nil, 0, err
}

// doAuthPostWithBearer posts JSON with a Bearer token for authenticated endpoints.
func doAuthPostWithBearer(path string, payload interface{}, token string) ([]byte, int, error) {
	body, status, err := postJSONWithSecretToBase(authBaseURL, createBcaiClient(), path, payload, token)
	if err == nil {
		return body, status, nil
	}
	body, status, err = postJSONWithSecretToBase(authBaseURL, createHttpClient(""), path, payload, token)
	if err == nil {
		return body, status, nil
	}
	return nil, 0, err
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
// seedEntitlementsBeforeLease 在首次自动租号前,用一次心跳把「订阅授权(产品并集 + 是否有
// 生效订阅)」喂给 leaser。这样 StartAutoLease 启动时 entitlementsKnown 已为真,decideAntigravity
// 能直接判 agAttempt/agSkip/agNoSub —— 不再冷启动「盲探一次 antigravity」:只开 codex/anthropic
// 的有效订阅会被租号端点回 SUBSCRIPTION_EXPIRED(该码语义二义)误判整卡不可用,在仪表盘闪一段
// 假的「订阅已到期」横幅。服务端心跳对无生效订阅返回 200 + subscriptions:[](非 403),故此处
// 只认 200;离线/会话失效/旧服务端 → 不 seed,回退到老的盲探逻辑(行为不退化)。
func seedEntitlementsBeforeLease(cfg Config) {
	payload := map[string]interface{}{
		"deviceId":      cfg.DeviceId,
		"clientVersion": AppVersion,
	}
	body, status, err := doAuthPostWithBearer("/app/heartbeat", payload, cfg.UserToken)
	if err != nil || status != http.StatusOK {
		return
	}
	var result map[string]interface{}
	if json.Unmarshal(body, &result) != nil {
		return
	}
	if products, hasActive, ok := parseHeartbeatEntitlements(result); ok {
		GetLeaser().SetEntitlements(products, hasActive)
	}
}

func startServicesForUser(cfg Config) {
	// Use UserToken as the "card" parameter throughout the lease/proxy chain;
	// leaser passes it to postJSONWithSecretToBase which now sets Bearer.
	token := cfg.UserToken
	deviceId := cfg.DeviceId

	// Start auto-lease (antigravity path). Session accounts lease directly with
	// the JWT — the old card /api/activate handshake is gone (server stubbed it
	// fail-closed after the force-upgrade; products now arrive with each lease
	// response's accessKeyStatus).
	//
	// 先 seed 授权再租号(见 seedEntitlementsBeforeLease)。放后台 goroutine:不阻塞启动/登录
	// (HTTP 代理在下方照常先起,真实请求可按需租号);seed 完成后再 StartAutoLease,
	// 据已知授权正确路由,杜绝冷启动盲探误判。
	go func() {
		seedEntitlementsBeforeLease(cfg)
		GetLeaser().StartAutoLease(token, deviceId, "")
	}()

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
	cfg.Subscriptions = nil
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
	cfg.Subscriptions = resp.snapshots()
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

	// 多订阅展示快照:nil → 空数组,保证前端拿到 [] 而非 null。
	subs := cfg.Subscriptions
	if subs == nil {
		subs = []SubscriptionSnapshot{}
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
		"subscriptions": subs,
		// cardUnusable-equivalent: token expired or empty
		"sessionUnusable": !loggedIn || tokenExpired,
	}
}

// SetSubscriptionPriority 调整某订阅的接力优先级:POST /account/subscriptions/priority。
// 与 web portal 同一套 customer JWT 鉴权 —— CustomerJwtGuard 只校验 typ/customer/
// tokenVersion,不看 deviceId,故客户端会话 token 可直接调用该端点。本方法只发请求;
// 调用方随后心跳一次刷新本地多订阅快照,让新顺序立即生效(无需重登/等轮询)。
func (a *App) SetSubscriptionPriority(subscriptionId string, priority int) error {
	a.lock.Lock()
	defer a.lock.Unlock()

	cfg := LoadConfig()
	if cfg.UserToken == "" {
		return fmt.Errorf("not logged in")
	}

	payload := map[string]interface{}{
		"subscriptionId": subscriptionId,
		"priority":       priority,
	}
	body, status, err := doAuthPostWithBearer("/account/subscriptions/priority", payload, cfg.UserToken)
	if err != nil {
		return fmt.Errorf("set priority network error: %w", err)
	}
	// NestJS 的 @Post 默认回 201 Created;priority 更新成功是 2xx。只把非 2xx 当失败
	// —— 此前误用 != 200 把成功的 201 判成失败,弹错误框 + 白回滚。
	if status < 200 || status >= 300 {
		// 尽量提取后端 error/message,避免把整段响应体糊给用户。
		var errResp loginErrorResponse
		if json.Unmarshal(body, &errResp) == nil && errResp.Error != "" {
			return fmt.Errorf("%s: %s", errResp.Error, errResp.Message)
		}
		return fmt.Errorf("set priority failed (HTTP %d)", status)
	}
	return nil
}

// min returns the smaller of a, b (local helper to avoid Go 1.21 requirement).
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// parseHeartbeatSubscriptions extracts the full subscriptions array from a
// /app/heartbeat response. The bool is false ONLY when the key is absent (older
// server) — callers must not clear the local snapshot in that case. A present
// key (including null or []) yields the parsed list (possibly empty), which is a
// legitimate "all subs lapsed" signal.
func parseHeartbeatSubscriptions(result map[string]interface{}) ([]SubscriptionSnapshot, bool) {
	raw, present := result["subscriptions"]
	if !present {
		return nil, false
	}
	arr, _ := raw.([]interface{}) // null / non-array → empty list
	out := make([]SubscriptionSnapshot, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		snap := SubscriptionSnapshot{Products: []string{}}
		if v, ok := m["id"].(string); ok {
			snap.Id = v
		}
		if v, ok := m["status"].(string); ok {
			snap.Status = v
		}
		if v, ok := m["expiresAt"].(string); ok {
			snap.ExpiresAt = v
		}
		if v, ok := m["deviceLimit"].(float64); ok {
			snap.DeviceLimit = int(v)
		}
		if v, ok := m["priority"].(float64); ok {
			snap.Priority = int(v)
		}
		if v, ok := m["products"].([]interface{}); ok {
			for _, p := range v {
				if ps, ok := p.(string); ok {
					snap.Products = append(snap.Products, ps)
				}
			}
		}
		if v, ok := m["remainFraction"].(float64); ok {
			f := v
			snap.RemainFraction = &f
		}
		out = append(out, snap)
	}
	return out, true
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

	// Feed subscription entitlements (product union + has-active-sub) into the
	// leaser so StartAutoLease decides the antigravity path WITHOUT a blind probe
	// lease — fixes the cold-start "codex/anthropic-only sub → whole card unusable"
	// misfire. ok=false means the server didn't carry subscriptions (old build) →
	// leave entitlements unknown (legacy behavior).
	if products, hasActive, ok := parseHeartbeatEntitlements(result); ok {
		leaser := GetLeaser()
		leaser.SetEntitlements(products, hasActive)
		// 冷启动可能在首次心跳之前盲租 antigravity 把卡误判不可用。现确知有生效订阅、且不需要
		// antigravity(只 codex/anthropic)→ 重新接管:StartAutoLease 据新授权走 agSkip,清掉
		// 误判、放行 codex/anthropic,无需用户手动刷新。需要 antigravity 的真失败不在此重试。
		if hasActive && leaser.IsCardUnusable() && !productListContains(products, "antigravity") {
			leaser.StartAutoLease(cfg.UserToken, cfg.DeviceId, "")
		}
	}

	// Refresh the local subscription snapshots so plan renewals/changes show up in
	// the UI (GetAccountState reads config) without a re-login. The single-sub
	// fields (PlanName/PlanExpiry/PlanDeviceMax) stay for legacy single-sub UI and
	// checks; the full `subscriptions` array drives the multi-sub list. Both are
	// folded into one `changed` flag → at most one SaveConfig per heartbeat.
	changed := false

	subVal, hasSubKey := result["subscription"]
	if sub, ok := subVal.(map[string]interface{}); ok {
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
	} else if hasSubKey {
		// Server explicitly reported no active subscription (subscription: null) —
		// the plan lapsed or was removed. Clear the stale single-sub snapshot so the
		// UI stops showing a subscribed/expiry state carried over from a previous plan.
		// (The key-present guard avoids wiping when an older server omits the field.)
		if cfg.PlanName != "" || cfg.PlanExpiry != "" || cfg.PlanDeviceMax != 0 {
			cfg.PlanName = ""
			cfg.PlanExpiry = ""
			cfg.PlanDeviceMax = 0
			changed = true
		}
	}

	// Full subscriptions array (multi-sub list). present=false means an older server
	// omitted the field → leave the local array untouched (no spurious wipe). A
	// present-but-empty array (all subs lapsed) is a real update that clears the list.
	if snaps, present := parseHeartbeatSubscriptions(result); present {
		if !reflect.DeepEqual(cfg.Subscriptions, snaps) {
			cfg.Subscriptions = snaps
			changed = true
		}
	}

	if changed {
		if saveErr := SaveConfig(cfg); saveErr != nil {
			Log("[auth] Failed to persist heartbeat subscription update: %v", saveErr)
		}
	}
	return result, nil
}
