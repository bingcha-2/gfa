package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// ─── Quota Sync (远程租号模式的额度采集) ─────────────────────────────────────
//
// 本文件包含客户端利用 lease 的 access_token 查询 Google API 获取账号额度的逻辑：
// - fetchHealthViaToken:   独立的 loadCodeAssist API 调用（不依赖 AccountPool）
// - fetchModelsViaToken:   独立的 fetchAvailableModels API 调用
// - fetchAccountQuotaAsync: 异步 CAS 保护的查询入口

// ─── Data Structures ────────────────────────────────────────────────────

// AccountQuotaSnapshot 缓存从 Google API 获取的账号额度快照
type AccountQuotaSnapshot struct {
	AccountId  int                        `json:"accountId"`
	PlanType   string                     `json:"planType"`
	Credits    *AccountCreditsInfo        `json:"credits,omitempty"`
	ModelQuota map[string]ModelQuotaEntry  `json:"modelQuota,omitempty"`
	FetchedAt  int64                      `json:"fetchedAt"`
}

// AccountCreditsInfo AI 积分信息
type AccountCreditsInfo struct {
	Known           bool    `json:"known"`
	Available       bool    `json:"available"`
	CreditAmount    float64 `json:"creditAmount"`
	MinCreditAmount float64 `json:"minCreditAmount"`
	PaidTierID      string  `json:"paidTierID"`
}

// ModelQuotaEntry 单个模型的额度信息
type ModelQuotaEntry struct {
	RemainingFraction float64 `json:"remainingFraction"`
	ResetTime         string  `json:"resetTime,omitempty"`
}

// ─── Google API Callers (不依赖 AccountPool) ────────────────────────────

// fetchHealthViaToken 用 access_token 调用 loadCodeAssist API
// 返回 (credits, planType)。失败时 credits=nil, planType="free"。
func fetchHealthViaToken(accessToken string) (*AccountCreditsInfo, string) {
	return fetchHealthViaTokenWithEndpoint(DailyCloudEndpoint, accessToken)
}

// fetchHealthViaTokenWithEndpoint 可注入 endpoint 的版本（方便测试）
func fetchHealthViaTokenWithEndpoint(endpoint, accessToken string) (*AccountCreditsInfo, string) {
	payload, _ := json.Marshal(map[string]interface{}{
		"metadata": map[string]string{"ideType": "ANTIGRAVITY"},
	})

	req, err := http.NewRequest("POST", endpoint+"/v1internal:loadCodeAssist",
		strings.NewReader(string(payload)))
	if err != nil {
		return nil, "free"
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "google-antigravity-ls/1.26.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "free"
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "free"
	}

	var data map[string]interface{}
	if json.Unmarshal(body, &data) != nil {
		return nil, "free"
	}

	// ── 解析 planType ──
	planType := "free"
	if pt, ok := data["paidTier"].(map[string]interface{}); ok {
		raw := ""
		if name, ok := pt["name"].(string); ok && name != "" {
			raw = name
		} else if id, ok := pt["id"].(string); ok && id != "" {
			raw = id
		}
		if raw != "" {
			lower := strings.ToLower(raw)
			switch {
			case strings.Contains(lower, "ultra"):
				planType = "ultra"
			case strings.Contains(lower, "premium") || strings.Contains(lower, "ai pro") || strings.Contains(lower, "helium"):
				planType = "premium"
			case strings.Contains(lower, "standard"):
				planType = "standard"
			case strings.Contains(lower, "free"):
				planType = "free"
			default:
				planType = raw
			}
		}
	}

	// ── 解析 credits ──
	pt, hasPaidTier := data["paidTier"].(map[string]interface{})
	if !hasPaidTier {
		return nil, planType
	}

	ptid, _ := pt["id"].(string)
	credits := &AccountCreditsInfo{PaidTierID: ptid}

	creditsArr, hasCredits := pt["availableCredits"].([]interface{})
	if !hasCredits {
		// Pro/Premium 等无 credits 字段
		credits.Known = true
		credits.Available = false
		return credits, planType
	}

	for _, c := range creditsArr {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		creditType, _ := cm["creditType"].(string)
		if strings.ToUpper(creditType) != "GOOGLE_ONE_AI" {
			continue
		}
		credits.Known = true
		credits.CreditAmount = toFloat64(cm["creditAmount"])
		credits.MinCreditAmount = toFloat64(cm["minimumCreditAmountForUsage"])
		credits.Available = credits.CreditAmount >= credits.MinCreditAmount
		break
	}

	return credits, planType
}

// fetchModelsViaToken 用 access_token + projectId 调用 fetchAvailableModels
// 使用 DailyCloudEndpoint 以获取完整模型列表（包含 Claude/GPT 第三方模型）。
// 返回 map[modelKey]ModelQuotaEntry，失败时返回 nil。
func fetchModelsViaToken(accessToken, projectId string) map[string]ModelQuotaEntry {
	return fetchModelsViaTokenWithEndpoint(DailyCloudEndpoint, accessToken, projectId)
}

// fetchModelsViaTokenWithEndpoint 可注入 endpoint 的版本（方便测试）
func fetchModelsViaTokenWithEndpoint(endpoint, accessToken, projectId string) map[string]ModelQuotaEntry {
	reqBody, _ := json.Marshal(map[string]string{"project": projectId})
	req, err := http.NewRequest("POST", endpoint+"/v1internal:fetchAvailableModels",
		strings.NewReader(string(reqBody)))
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "google-antigravity-ls/1.26.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil
	}

	var raw map[string]interface{}
	if json.Unmarshal(body, &raw) != nil {
		return nil
	}

	modelsRaw, ok := raw["models"]
	if !ok {
		return nil
	}
	modelsMap, ok := modelsRaw.(map[string]interface{})
	if !ok || len(modelsMap) == 0 {
		return nil
	}

	result := make(map[string]ModelQuotaEntry, len(modelsMap))
	for key, modelDataRaw := range modelsMap {
		modelData, ok := modelDataRaw.(map[string]interface{})
		if !ok {
			continue
		}
		entry := ModelQuotaEntry{}
		if qi, ok := modelData["quotaInfo"].(map[string]interface{}); ok {
			if rf, ok := qi["remainingFraction"].(float64); ok {
				entry.RemainingFraction = rf
			}
			if rt, ok := qi["resetTime"].(string); ok {
				entry.ResetTime = rt
			}
		}
		result[key] = entry
	}
	return result
}

// ─── Leaser 集成 ────────────────────────────────────────────────────────

// claimQuotaFetch 至多每 codexQuotaMinIntervalMs 返回一次 true 并打时间戳。
// 首次(从未拉取)放行。对齐 codex 节流,避免每次上报都打 Google fetchAvailableModels。
func (l *Leaser) claimQuotaFetch(nowMs int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lastQuotaFetchAt != 0 && nowMs-l.lastQuotaFetchAt < codexQuotaMinIntervalMs {
		return false
	}
	l.lastQuotaFetchAt = nowMs
	return true
}

// fetchAccountQuotaAsync 异步查询当前 lease 账号的额度信息
// 时间节流(claimQuotaFetch)+ CAS 保护：同一时间只允许一个查询，且不超频。
func (l *Leaser) fetchAccountQuotaAsync() {
	if !l.claimQuotaFetch(time.Now().UnixMilli()) {
		return
	}
	// CAS 防并发
	if !atomic.CompareAndSwapInt32(&l.quotaFetching, 0, 1) {
		return
	}
	defer atomic.StoreInt32(&l.quotaFetching, 0)

	l.mu.RLock()
	token := l.cachedToken
	l.mu.RUnlock()

	if token == nil || token.AccessToken == "" || token.ProjectId == "" {
		return
	}
	// token 有效性：剩余 >2min 才查
	nowMs := time.Now().UnixMilli()
	if token.ExpiresAt > 0 && (token.ExpiresAt-nowMs) < 120_000 {
		return
	}

	snapshot := &AccountQuotaSnapshot{
		AccountId: token.AccountId,
		FetchedAt: time.Now().UnixMilli(),
	}

	// 1. loadCodeAssist → credits + planType
	credits, planType := fetchHealthViaToken(token.AccessToken)
	snapshot.Credits = credits
	snapshot.PlanType = planType

	// 2. fetchAvailableModels → per-model quota
	snapshot.ModelQuota = fetchModelsViaToken(token.AccessToken, token.ProjectId)

	l.mu.Lock()
	l.cachedQuotaSnapshot = snapshot
	l.mu.Unlock()

}

// ResetQuotaSync 清理 quota 缓存（切换账号等场景）
func (l *Leaser) ResetQuotaSync() {
	l.mu.Lock()
	l.cachedQuotaSnapshot = nil
	l.mu.Unlock()
}

// GetCachedQuotaSnapshot 返回缓存的快照（用于前端展示，只读安全）
func (l *Leaser) GetCachedQuotaSnapshot() *AccountQuotaSnapshot {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.cachedQuotaSnapshot
}

// ConsumeQuotaSnapshot 消费缓存的快照（一次性），用于 report-result 附带
func (l *Leaser) ConsumeQuotaSnapshot() *AccountQuotaSnapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.cachedQuotaSnapshot
	l.cachedQuotaSnapshot = nil
	return s
}

// isoToEpochMs 把 RFC3339 时间串转 epoch ms;空/解析失败返回 0(未知)。
func isoToEpochMs(iso string) int64 {
	if iso == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// reportQuotaOnly 发一条只带 accountQuota 的 report,让服务端即时更新该号的 per-model
// 额度(用当前 lease 的 leaseId,服务端据此解出 accountId;status=0 不计费)。
func (l *Leaser) reportQuotaOnly(card, upstreamProxy string, snap *AccountQuotaSnapshot) {
	l.mu.RLock()
	lease := l.cachedToken
	l.mu.RUnlock()
	if lease == nil || lease.LeaseId == "" || snap == nil {
		return
	}
	payload := map[string]interface{}{
		"leaseId":      lease.LeaseId,
		"reportId":     newReportID(lease.LeaseId) + "-quota",
		"accountId":    lease.AccountId,
		"status":       0,
		"accountQuota": snap,
	}
	if _, _, err := postBcaiWithFallback("/report-result", payload, card, upstreamProxy); err != nil {
		Log("[quota-sync] 即时额度上报失败(不致命): %v", err)
		return
	}
	Log("[quota-sync] ✓ 上报成功 [antigravity] account#%d", lease.AccountId)
}

// refreshBoundAntigravityQuota 主动拉一次上游 per-model 额度 → 记录血条 + 上报服务端。
// 绑定模式激活/定时刷新调用 —— 否则 antigravity 只在"真实生成上报"之后才拉额度,
// 纯激活(还没发请求)时血条没数据。fetchAccountQuotaAsync 自带 5min 节流。
func (l *Leaser) refreshBoundAntigravityQuota(card, upstreamProxy string, force bool) {
	if force {
		// 激活/换卡:清掉节流时间戳,保证这次一定真去拉(否则 5min 内会被跳过)。
		l.mu.Lock()
		l.lastQuotaFetchAt = 0
		l.mu.Unlock()
	}
	l.fetchAccountQuotaAsync()
	snap := l.ConsumeQuotaSnapshot()
	if snap == nil {
		return // 被节流跳过 / 拉取失败 —— 血条仍由租号响应的 accountBuckets 兜底
	}
	for modelKey, q := range snap.ModelQuota {
		recordBoundFractionForModel(modelKey, q.RemainingFraction, isoToEpochMs(q.ResetTime))
	}
	l.reportQuotaOnly(card, upstreamProxy, snap)
}

// formatQuotaSyncLog 格式化日志（避免在 fetchAccountQuotaAsync 中过长）
func formatQuotaSyncLog(snapshot *AccountQuotaSnapshot) string {
	if snapshot == nil {
		return "<nil>"
	}
	creditAmt := float64(0)
	if snapshot.Credits != nil {
		creditAmt = snapshot.Credits.CreditAmount
	}
	return fmt.Sprintf("plan=%s credits=%.0f models=%d",
		snapshot.PlanType, creditAmt, len(snapshot.ModelQuota))
}
