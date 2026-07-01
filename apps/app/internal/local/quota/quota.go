// Package quota 直接照 cockpit 移植「按号额度刷新 + token 续约」。
//
// codex 额度移植自 cockpit crates/cockpit-core/src/modules/codex_quota.rs:
//   - fetch_quota -> CodexFetcher.FetchQuota:GET chatgpt.com/backend-api/wham/usage,
//     Authorization: Bearer + ChatGPT-Account-Id;rate_limit.primary_window(5h)/
//     secondary_window(周)的 used_percent -> 剩余=100-used,reset_at / reset_after_seconds。
//   - refresh_access_token -> CodexFetcher.RefreshToken:POST auth.openai.com/oauth/token,
//     grant_type=refresh_token,client_id=app_EMoamEEZ73f0CkXaXp7hrann;缺 id/refresh 复用旧值。
//   - is_token_expired / extract_chatgpt_account_id_from_access_token 照搬 codex_account.rs 的
//     JWT 解析(codex 不验签,只解 payload)。
//
// antigravity token 续约照搬内嵌 CLIProxyAPI internal/auth/antigravity/constants.go 的
// Google OAuth(POST oauth2.googleapis.com/token,client_id/secret 内置)。
package quota

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"bcai-wails/internal/local/account"
)

// ── 照搬 cockpit 的上游常量(可在构造时覆盖,便于测试 mock) ──

const (
	codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"
	codexTokenURL = "https://auth.openai.com/oauth/token"
	codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

	// 移植自内嵌 CLIProxyAPI internal/auth/antigravity/constants.go。
	antigravityTokenURL     = "https://oauth2.googleapis.com/token"
	antigravityClientID     = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
	antigravityClientSecret = "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"

	httpTimeout = 25 * time.Second
)

// Result 是一次额度查询的归一结果(回填进 account)。
type Result struct {
	HourlyPercent int    // 剩余百分比 0..100(仅 HourlyKnown 时有效)
	WeeklyPercent int    // 剩余百分比 0..100(仅 WeeklyKnown 时有效)
	HourlyResetAt int64  // unix ms(0=未知)
	WeeklyResetAt int64  // unix ms
	HourlyKnown   bool   // 上游是否真给了 5h 窗口(false=未知,调用方应 keep-prior,绝不伪造满血)
	WeeklyKnown   bool   // 上游是否真给了 周 窗口
	PlanType      string // 上游返回的订阅档(可空)
	// Buckets 是多窗口/多模型族剩余额度(antigravity 4 桶:gemini/claude × 5h/周)。
	// 非空即由调用方覆盖写入 account.Buckets;codex 留空(仍走 Hourly/Weekly)。
	Buckets []account.QuotaBucket
	// ResetCreditsAvailable 主动重置可用次数(rate_limit_reset_credits.available_count)。
	// 照搬 cockpit reset_credits_available(Option<i64>):nil=上游未报,*v=0 表示确为 0 次。
	// 注:GFA「主动重置次数」UI 走专用 codexbiz 路径(GetCodexResetCredits),此处仅随额度
	// 解析一并带出、避免静默丢字段(与 wham/usage 同源,可供列表级「一眼可用次数」复用)。
	ResetCreditsAvailable *int64
}

// CodexTokens 是 codex token 刷新结果。
type CodexTokens struct {
	IDToken      string
	AccessToken  string
	RefreshToken string
}

// AntigravityTokens 是 antigravity token 刷新结果。
type AntigravityTokens struct {
	AccessToken string
	Expiry      int64 // unix 秒
}

// ── codex ──

type CodexEndpoints struct {
	UsageURL string
	TokenURL string
	ClientID string
}

type CodexFetcher struct {
	ep CodexEndpoints
	hc *http.Client
}

func NewCodexFetcher(ep CodexEndpoints) *CodexFetcher {
	if ep.UsageURL == "" {
		ep.UsageURL = codexUsageURL
	}
	if ep.TokenURL == "" {
		ep.TokenURL = codexTokenURL
	}
	if ep.ClientID == "" {
		ep.ClientID = codexClientID
	}
	return &CodexFetcher{ep: ep, hc: &http.Client{Timeout: httpTimeout}}
}

// FetchQuota 照搬 cockpit codex_quota::fetch_quota。
func (c *CodexFetcher) FetchQuota(acc *account.Account) (Result, error) {
	req, err := http.NewRequest(http.MethodGet, c.ep.UsageURL, nil)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Authorization", "Bearer "+acc.AccessToken)
	req.Header.Set("Accept", "application/json")
	// ChatGPT-Account-Id(关键):优先账号上已知 id,否则从 access_token JWT 提取。
	accID := acc.AccountID
	if accID == "" {
		accID = extractChatGPTAccountID(acc.AccessToken)
	}
	if accID != "" {
		req.Header.Set("ChatGPT-Account-Id", accID)
	}

	resp, err := c.hc.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return Result{}, fmt.Errorf("API 返回错误 %d [body_len:%d]", resp.StatusCode, len(body))
	}

	var usage usageResponse
	if err := json.Unmarshal(body, &usage); err != nil {
		return Result{}, fmt.Errorf("解析 JSON 失败: %w", err)
	}
	return parseQuotaFromUsage(&usage), nil
}

// RefreshToken 照搬 cockpit codex_oauth::refresh_access_token_with_fallback。
func (c *CodexFetcher) RefreshToken(refreshToken, currentIDToken string) (CodexTokens, error) {
	payload, _ := json.Marshal(map[string]string{
		"client_id":     c.ep.ClientID,
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
	})
	req, err := http.NewRequest(http.MethodPost, c.ep.TokenURL, bytes.NewReader(payload))
	if err != nil {
		return CodexTokens{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return CodexTokens{}, fmt.Errorf("Token 刷新请求失败: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return CodexTokens{}, fmt.Errorf("Token 刷新失败: status=%d body_len=%d", resp.StatusCode, len(body))
	}

	var tr struct {
		IDToken      string `json:"id_token"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return CodexTokens{}, fmt.Errorf("解析 Token 响应失败: %w", err)
	}
	if tr.AccessToken == "" {
		return CodexTokens{}, fmt.Errorf("响应中缺少 access_token")
	}
	// 缺 id_token/refresh_token 时复用旧值(对齐 cockpit fallback)。
	if tr.IDToken == "" {
		tr.IDToken = currentIDToken
	}
	if tr.RefreshToken == "" {
		tr.RefreshToken = refreshToken
	}
	return CodexTokens{IDToken: tr.IDToken, AccessToken: tr.AccessToken, RefreshToken: tr.RefreshToken}, nil
}

// ── antigravity(Google OAuth 刷新;额度=轻探,见 hub) ──

type AntigravityEndpoints struct {
	TokenURL     string
	ClientID     string
	ClientSecret string
	// CloudCodeBaseURL 覆盖额度端点(Google Cloud Code Companion API);
	// 空=按账号 is_gcp_tos 选 daily/prod(见 antigravity_cloudcode.go)。测试注入 mock。
	CloudCodeBaseURL string
}

type AntigravityFetcher struct {
	ep AntigravityEndpoints
	hc *http.Client
}

func NewAntigravityFetcher(ep AntigravityEndpoints) *AntigravityFetcher {
	if ep.TokenURL == "" {
		ep.TokenURL = antigravityTokenURL
	}
	if ep.ClientID == "" {
		ep.ClientID = antigravityClientID
	}
	if ep.ClientSecret == "" {
		ep.ClientSecret = antigravityClientSecret
	}
	return &AntigravityFetcher{ep: ep, hc: &http.Client{Timeout: httpTimeout}}
}

// RefreshToken 照搬内嵌 CLIProxyAPI 的 Google OAuth 刷新(form 编码)。
func (c *AntigravityFetcher) RefreshToken(refreshToken string) (AntigravityTokens, error) {
	form := url.Values{}
	form.Set("client_id", c.ep.ClientID)
	form.Set("client_secret", c.ep.ClientSecret)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)

	req, err := http.NewRequest(http.MethodPost, c.ep.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return AntigravityTokens{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.hc.Do(req)
	if err != nil {
		return AntigravityTokens{}, fmt.Errorf("Token 刷新请求失败: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return AntigravityTokens{}, fmt.Errorf("Token 刷新失败: status=%d body_len=%d", resp.StatusCode, len(body))
	}

	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return AntigravityTokens{}, fmt.Errorf("解析 Token 响应失败: %w", err)
	}
	if tr.AccessToken == "" {
		return AntigravityTokens{}, fmt.Errorf("响应中缺少 access_token")
	}
	var exp int64
	if tr.ExpiresIn > 0 {
		exp = time.Now().Unix() + tr.ExpiresIn
	}
	return AntigravityTokens{AccessToken: tr.AccessToken, Expiry: exp}, nil
}

// ── 解析/JWT 辅助(照搬 cockpit codex_quota.rs / codex_account.rs) ──

type windowInfo struct {
	UsedPercent       *int   `json:"used_percent"`
	ResetAfterSeconds *int64 `json:"reset_after_seconds"`
	ResetAt           *int64 `json:"reset_at"`
}

type usageResponse struct {
	PlanType  string `json:"plan_type"`
	RateLimit *struct {
		PrimaryWindow   *windowInfo `json:"primary_window"`
		SecondaryWindow *windowInfo `json:"secondary_window"`
	} `json:"rate_limit"`
	// rate_limit_reset_credits 与 rate_limit 平级(非嵌套):主动重置次数,
	// 照搬 cockpit ResetCreditsInfo.available_count(codex_quota.rs:207-209)。
	RateLimitResetCredits *struct {
		AvailableCount *int64 `json:"available_count"`
	} `json:"rate_limit_reset_credits"`
}

// normalizeRemainingPercentage 照搬 cockpit:remaining = 100 - clamp(used,0,100)。
func normalizeRemainingPercentage(w *windowInfo) int {
	used := 0
	if w.UsedPercent != nil {
		used = *w.UsedPercent
	}
	if used < 0 {
		used = 0
	}
	if used > 100 {
		used = 100
	}
	return 100 - used
}

// normalizeResetTimeMs 照搬 cockpit normalize_reset_time:优先 reset_at,
// 否则 now+reset_after_seconds(秒);返回 unix ms(0=未知)。
func normalizeResetTimeMs(w *windowInfo) int64 {
	if w.ResetAt != nil {
		return *w.ResetAt * 1000
	}
	if w.ResetAfterSeconds != nil && *w.ResetAfterSeconds >= 0 {
		return (time.Now().Unix() + *w.ResetAfterSeconds) * 1000
	}
	return 0
}

// parseQuotaFromUsage:primary_window=5小时,secondary_window=周。
// 缺窗口 = 未知(Known=false),由调用方 keep-prior —— 绝不伪造满血(100)。
// 伪造满血会让缺窗口的号在 fair 路由里冒充满额、把流量吸过去,正是
// memory codex-quota-window-unknown-parity 记录的已修坑,这里不能复现。
func parseQuotaFromUsage(u *usageResponse) Result {
	res := Result{PlanType: u.PlanType}
	// 主动重置次数与 rate_limit 平级:在 rate_limit 缺失早返回之前先取,避免漏带。
	if rc := u.RateLimitResetCredits; rc != nil {
		res.ResetCreditsAvailable = rc.AvailableCount
	}
	if u.RateLimit == nil {
		return res
	}
	if p := u.RateLimit.PrimaryWindow; p != nil {
		res.HourlyPercent = normalizeRemainingPercentage(p)
		res.HourlyResetAt = normalizeResetTimeMs(p)
		res.HourlyKnown = true
	}
	if s := u.RateLimit.SecondaryWindow; s != nil {
		res.WeeklyPercent = normalizeRemainingPercentage(s)
		res.WeeklyResetAt = normalizeResetTimeMs(s)
		res.WeeklyKnown = true
	}
	return res
}

// extractChatGPTAccountID 照搬 codex_account::extract_chatgpt_account_id_from_access_token:
// JWT payload["https://api.openai.com/auth"]["chatgpt_account_id" | "account_id"]。
func extractChatGPTAccountID(accessToken string) string {
	payload := decodeJWTPayload(accessToken)
	if payload == nil {
		return ""
	}
	authData, _ := payload["https://api.openai.com/auth"].(map[string]any)
	if authData == nil {
		return ""
	}
	for _, k := range []string{"chatgpt_account_id", "account_id"} {
		if v, ok := authData[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// isJWTExpired 照搬 codex_oauth::is_jwt_token_expired:解 payload.exp,过期=true。
// 解析失败(非 JWT)按未过期处理(对齐 cockpit:无 exp 不主动判过期)。
func isJWTExpired(accessToken string) bool {
	payload := decodeJWTPayload(accessToken)
	if payload == nil {
		return false
	}
	expVal, ok := payload["exp"]
	if !ok {
		return false
	}
	var exp int64
	switch v := expVal.(type) {
	case float64:
		exp = int64(v)
	case json.Number:
		exp, _ = v.Int64()
	default:
		return false
	}
	return time.Now().Unix() >= exp
}

func decodeJWTPayload(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// 兼容带 padding 的 base64url。
		raw, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil
		}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}
