package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// ─── Codex Quota Sync ────────────────────────────────────────────────────────
//
// Mirrors quota_sync.go (antigravity) for Codex: queries the upstream
// chatgpt.com/backend-api/wham/usage endpoint with the leased access token to
// read the account's 5h (primary) + weekly (secondary) rate-limit windows, then
// attaches a remaining-percentage snapshot to the next report-result so the
// server can quota-aware its codex account selection. Best-effort throughout —
// any failure just skips the snapshot (no behavior change).

var CODEX_USAGE_URL = getEnvOrDefault("BCAI_CODEX_USAGE_URL", "https://chatgpt.com/backend-api/wham/usage")

// CodexQuotaWindow holds remaining-percentage (0-100, higher = healthier) for
// the two codex rate-limit windows, matching the server's applyQuotaSnapshot.
type CodexQuotaWindow struct {
	HourlyPercent   float64 `json:"hourlyPercent"`
	WeeklyPercent   float64 `json:"weeklyPercent"`
	HourlyResetTime string  `json:"hourlyResetTime,omitempty"`
	WeeklyResetTime string  `json:"weeklyResetTime,omitempty"`
}

// CodexAccountQuotaSnapshot is attached to report-result as `accountQuota`.
type CodexAccountQuotaSnapshot struct {
	AccountId  int               `json:"accountId"`
	PlanType   string            `json:"planType,omitempty"`
	CodexQuota *CodexQuotaWindow `json:"codexQuota,omitempty"`
	FetchedAt  int64             `json:"fetchedAt"`
}

// Raw subset of the wham/usage response shape (see cockpit codex_quota.rs).
type codexUsageWindow struct {
	UsedPercent       *float64 `json:"used_percent"`
	ResetAfterSeconds *int64   `json:"reset_after_seconds"`
	ResetAt           *int64   `json:"reset_at"`
}

type codexUsageRateLimit struct {
	PrimaryWindow   *codexUsageWindow `json:"primary_window"`
	SecondaryWindow *codexUsageWindow `json:"secondary_window"`
}

type codexUsageResponse struct {
	PlanType  string               `json:"plan_type"`
	RateLimit *codexUsageRateLimit `json:"rate_limit"`
}

// ConsumeCodexQuotaSnapshot returns and clears the cached snapshot (one-shot,
// attached to the next report-result).
func (l *CodexLeaser) ConsumeCodexQuotaSnapshot() *CodexAccountQuotaSnapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.cachedQuota
	l.cachedQuota = nil
	return s
}

// peekCodexQuotaSnapshot 读但不清除缓存快照(供拉取后即时上报用)。
func (l *CodexLeaser) peekCodexQuotaSnapshot() *CodexAccountQuotaSnapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cachedQuota
}

// reportQuotaOnly 发一条只带 accountQuota 的 report,让服务端即时更新该账号的
// 5h/周限额(用同一个仍新鲜的 lease,保证服务端能按 leaseId 解出 accountId)。
// 与生成 report 用不同 reportId,不影响计费去重。
func (l *CodexLeaser) reportQuotaOnly(card, upstreamProxy string, lease *CodexTokenLease, snap *CodexAccountQuotaSnapshot) {
	if lease == nil || lease.LeaseId == "" || snap == nil || snap.CodexQuota == nil {
		return
	}
	payload := map[string]interface{}{
		"leaseId":      lease.LeaseId,
		"reportId":     newReportID(lease.LeaseId) + "-quota",
		"accountId":    lease.AccountId,
		"status":       0, // 非生成上报,仅用于刷新额度
		"accountQuota": snap,
	}
	if _, _, err := postCodexBcai("/report-result", payload, card, upstreamProxy); err != nil {
		Log("[codex-quota] 即时额度上报失败(不致命): %v", err)
		return
	}
	Log("[codex-quota] ✓ 上报成功 [codex] account#%d", lease.AccountId)
}

// 上游额度拉取的最小间隔。5h/周窗口变化很慢,没必要每个请求都拉。被节流跳过时
// cachedQuota 保持为空 → reportQuotaOnly 自然也不发,于是「额度拉取 + 额度上报」
// 整体降到至多每 codexQuotaMinIntervalMs 一次(用量上报仍每请求,计费不受影响)。
const codexQuotaMinIntervalMs int64 = 5 * 60 * 1000

// claimQuotaFetch 至多每 codexQuotaMinIntervalMs 返回一次 true,并打上时间戳。
// 首次(从未拉取,lastQuotaFetchAt=0)放行。
func (l *CodexLeaser) claimQuotaFetch(nowMs int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lastQuotaFetchAt != 0 && nowMs-l.lastQuotaFetchAt < codexQuotaMinIntervalMs {
		return false
	}
	l.lastQuotaFetchAt = nowMs
	return true
}

// fetchCodexQuotaAsync queries wham/usage with the leased token and caches a
// snapshot for the next report. Time-throttled (claimQuotaFetch) so a busy
// session doesn't hammer the usage endpoint, then CAS-guarded so only one runs
// at a time.
func (l *CodexLeaser) fetchCodexQuotaAsync(lease *CodexTokenLease, upstreamProxy string) {
	if lease == nil || lease.AccessToken == "" {
		return
	}
	if !l.claimQuotaFetch(time.Now().UnixMilli()) {
		return
	}
	if !atomic.CompareAndSwapInt32(&l.quotaFetching, 0, 1) {
		return
	}
	defer atomic.StoreInt32(&l.quotaFetching, 0)

	req, err := http.NewRequest("GET", CODEX_USAGE_URL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
	req.Header.Set("Accept", "application/json")
	if accID := extractChatGPTAccountId(lease.AccessToken); accID != "" {
		req.Header.Set("ChatGPT-Account-Id", accID)
	}

	resp, err := createHttpClient(upstreamProxy).Do(req)
	if err != nil {
		Log("[codex-quota] usage request failed: %v", err)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		Log("[codex-quota] usage status %d", resp.StatusCode)
		return
	}

	var usage codexUsageResponse
	if json.Unmarshal(body, &usage) != nil {
		return
	}
	window := parseCodexUsage(&usage)
	if window == nil {
		return
	}

	snap := &CodexAccountQuotaSnapshot{
		AccountId:  lease.AccountId,
		PlanType:   usage.PlanType,
		CodexQuota: window,
		FetchedAt:  time.Now().UnixMilli(),
	}
	l.mu.Lock()
	l.cachedQuota = snap // 一次性(给下次 report 带上)
	l.lastQuota = snap   // 持久(给前端血条显示)
	l.mu.Unlock()
}

func parseCodexUsage(u *codexUsageResponse) *CodexQuotaWindow {
	if u == nil || u.RateLimit == nil {
		return nil
	}
	now := time.Now().Unix()
	// 缺失窗口报 -1(未知),不伪装满血 100。若填 100,服务端会把 fair-share 低水位抬到 ~1.0,
	// 下次真实低值回来时整段跌幅被一次性归因给在场卡 → 血条卡死 0 而母号已恢复(与 Claude 同口径,
	// 见 claude.provider.ts applyQuotaSnapshot:服务端按 <0=未知保留上次好值)。
	w := &CodexQuotaWindow{HourlyPercent: -1, WeeklyPercent: -1}
	if p := u.RateLimit.PrimaryWindow; p != nil {
		w.HourlyPercent = codexRemainingPercent(p.UsedPercent)
		w.HourlyResetTime = codexResetIso(p, now)
	}
	if s := u.RateLimit.SecondaryWindow; s != nil {
		w.WeeklyPercent = codexRemainingPercent(s.UsedPercent)
		w.WeeklyResetTime = codexResetIso(s, now)
	}
	return w
}

// remaining% = 100 - used% (matches cockpit's normalize_remaining_percentage).
func codexRemainingPercent(used *float64) float64 {
	if used == nil {
		return 100
	}
	r := 100 - *used
	if r < 0 {
		r = 0
	}
	if r > 100 {
		r = 100
	}
	return r
}

func codexResetIso(w *codexUsageWindow, now int64) string {
	var ts int64
	if w.ResetAt != nil && *w.ResetAt > 0 {
		ts = *w.ResetAt
	} else if w.ResetAfterSeconds != nil && *w.ResetAfterSeconds >= 0 {
		ts = now + *w.ResetAfterSeconds
	} else {
		return ""
	}
	return time.Unix(ts, 0).UTC().Format(time.RFC3339)
}

// extractChatGPTAccountId reads chatgpt_account_id from the JWT access token's
// payload claim "https://api.openai.com/auth". Returns "" if unavailable.
func extractChatGPTAccountId(accessToken string) string {
	parts := strings.Split(accessToken, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payload, err = base64.RawStdEncoding.DecodeString(parts[1])
		if err != nil {
			return ""
		}
	}
	var claims map[string]interface{}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	auth, ok := claims["https://api.openai.com/auth"].(map[string]interface{})
	if !ok {
		return ""
	}
	if id, ok := auth["chatgpt_account_id"].(string); ok {
		return id
	}
	return ""
}
