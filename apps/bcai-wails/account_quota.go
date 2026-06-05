package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ─── Account Quota / Health (Google API 采集) ─────────────────────────────
//
// 本文件包含通过 Google Cloud Code API 获取账号额度信息的逻辑：
// - RefreshAllQuotas:     批量刷新所有账号
// - fetchAccountHealth:   loadCodeAssist API → 套餐 + AI 积分
// - refreshAccountQuota:  fetchAvailableModels API → 模型级额度
// - discoverProjectId:    onboardUser API → 自动发现 projectId
// - parseModelsResponse:  解析 fetchAvailableModels 响应

// RefreshAllQuotas 对所有启用的账号刷新额度快照
// 如果账号没有 projectId，会先自动发现
func (p *AccountPool) RefreshAllQuotas() int {
	p.mu.RLock()
	var targets []*AccountEntry
	for _, acc := range p.accounts {
		if acc.Enabled {
			targets = append(targets, acc)
		}
	}
	p.mu.RUnlock()

	updated := 0
	for _, acc := range targets {
		// 自动发现 projectId
		if acc.ProjectId == "" {
			Log("[quota-refresh] %s: no projectId, attempting auto-discovery...", acc.Email)
			if err := p.discoverProjectId(acc); err != nil {
				Log("[quota-refresh] %s: project discovery failed: %v", acc.Email, err)
				continue
			}
			Log("[quota-refresh] %s: discovered projectId: %s", acc.Email, acc.ProjectId)
		}

		// 获取套餐和积分信息
		if err := p.fetchAccountHealth(acc); err != nil {
			Log("[quota-refresh] %s: health fetch failed: %v", acc.Email, err)
		}

		if err := p.refreshAccountQuota(acc); err != nil {
			Log("[quota-refresh] %s: %v", acc.Email, err)
		} else {
			updated++
		}
		time.Sleep(500 * time.Millisecond) // 错开请求避免并发
	}
	if updated > 0 {
		Log("[quota-refresh] %d/%d accounts updated", updated, len(targets))
	}
	return updated
}

// fetchAccountHealth 通过 loadCodeAssist API 获取账号健康信息（套餐 + 积分）
// 对应插件中的 fetchAccountHealth 逻辑
func (p *AccountPool) fetchAccountHealth(acc *AccountEntry) error {
	token, err := p.GetAccessToken(acc.ID)
	if err != nil {
		return fmt.Errorf("token refresh: %w", err)
	}

	// 调用 loadCodeAssist API
	payload, _ := json.Marshal(map[string]interface{}{
		"metadata": map[string]string{
			"ideType": "ANTIGRAVITY",
		},
	})

	apiUrl := DailyCloudEndpoint + "/v1internal:loadCodeAssist"
	req, err := http.NewRequest("POST", apiUrl, strings.NewReader(string(payload)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "google-antigravity-ls/1.26.0")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("loadCodeAssist request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("loadCodeAssist HTTP %d", resp.StatusCode)
	}

	var data map[string]interface{}
	if err := json.Unmarshal(body, &data); err != nil {
		return fmt.Errorf("parse loadCodeAssist: %w", err)
	}

	// 调试日志：显示 paidTier 和 currentTier
	if pt, ok := data["paidTier"]; ok {
		ptJSON, _ := json.Marshal(pt)
		Log("[health] %s: paidTier: %s", acc.Email, string(ptJSON[:min(len(ptJSON), 500)]))
	} else {
		Log("[health] %s: no paidTier in response", acc.Email)
	}
	if ct, ok := data["currentTier"]; ok {
		ctJSON, _ := json.Marshal(ct)
		Log("[health] %s: currentTier: %s", acc.Email, string(ctJSON[:min(len(ctJSON), 300)]))
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	entry, ok := p.accounts[acc.ID]
	if !ok {
		return nil
	}

	// ── 提取套餐类型 ──
	planType := ""
	if pt, ok := data["paidTier"].(map[string]interface{}); ok {
		raw := ""
		if name, ok := pt["name"].(string); ok && name != "" {
			raw = name
		} else if id, ok := pt["id"].(string); ok && id != "" {
			raw = id
		}
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
		case raw != "":
			planType = raw
		}
	}
	if planType == "" {
		// fallback: currentTier
		if ct, ok := data["currentTier"].(map[string]interface{}); ok {
			if name, ok := ct["name"].(string); ok && name != "" {
				lower := strings.ToLower(name)
				switch {
				case strings.Contains(lower, "ultra"):
					planType = "ultra"
				case strings.Contains(lower, "premium"):
					planType = "premium"
				case strings.Contains(lower, "standard"):
					planType = "standard"
				case strings.Contains(lower, "free"):
					planType = "free"
				default:
					planType = name
				}
			}
		}
	}
	if planType != "" && planType != entry.PlanType {
		Log("[health] %s: plan %s → %s", acc.Email, entry.PlanType, planType)
		entry.PlanType = planType
		go p.SaveAccounts()
	}

	// ── 提取 AI 积分 (GOOGLE_ONE_AI) ──
	if pt, ok := data["paidTier"].(map[string]interface{}); ok {
		ptid, _ := pt["id"].(string)
		entry.paidTierID = ptid

		credits, hasCredits := pt["availableCredits"].([]interface{})
		if !hasCredits {
			// Pro 等套餐没有 availableCredits 字段
			// 参考 CLIProxyAPI: Known=true, Available=false
			entry.creditsKnown = true
			entry.creditsAvailable = false
			Log("[health] %s: paidTier=%s, no availableCredits field", acc.Email, ptid)
		} else {
			for _, c := range credits {
				cm, ok := c.(map[string]interface{})
				if !ok {
					continue
				}
				creditType, _ := cm["creditType"].(string)
				if strings.ToUpper(creditType) != "GOOGLE_ONE_AI" {
					continue
				}
				entry.creditsKnown = true
				entry.creditAmount = toFloat64(cm["creditAmount"])
				entry.minCreditAmount = toFloat64(cm["minimumCreditAmountForUsage"])
				entry.creditsAvailable = entry.creditAmount >= entry.minCreditAmount
				Log("[health] %s: credits=%.0f (min=%.0f, available=%v)",
					acc.Email, entry.creditAmount, entry.minCreditAmount, entry.creditsAvailable)
				break
			}
		}
	}

	return nil
}

// toFloat64 安全转换 interface{} 为 float64
func toFloat64(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	case int:
		return float64(n)
	default:
		return 0
	}
}

// discoverProjectId 通过 onboardUser API 自动发现账号的 projectId
// 对应插件中的 discoverProjectViaApi 逻辑
func (p *AccountPool) discoverProjectId(acc *AccountEntry) error {
	token, err := p.GetAccessToken(acc.ID)
	if err != nil {
		return fmt.Errorf("token refresh: %w", err)
	}

	// 调用 onboardUser API
	onboardPayload, _ := json.Marshal(map[string]interface{}{
		"tierId": "standard-tier",
		"metadata": map[string]string{
			"ideType": "ANTIGRAVITY",
		},
	})

	apiUrl := DailyCloudEndpoint + "/v1internal:onboardUser"
	req, err := http.NewRequest("POST", apiUrl, strings.NewReader(string(onboardPayload)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "google-antigravity-ls/1.26.0")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("onboardUser request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("onboardUser HTTP %d: %s", resp.StatusCode, string(body[:min(len(body), 200)]))
	}

	// 解析响应，提取 projectId
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("parse onboardUser response: %w", err)
	}

	Log("[quota-refresh] %s: onboardUser response: %s", acc.Email, string(body[:min(len(body), 500)]))

	// 尝试从 response.cloudaicompanionProject 提取 projectId
	projectId := extractProjectIdFromOnboard(result)

	// 如果是 LRO（长轮询操作），需要等待
	if projectId == "" {
		if name, ok := result["name"].(string); ok && name != "" {
			done, _ := result["done"].(bool)
			if !done {
				Log("[quota-refresh] %s: onboardUser returned LRO: %s, polling...", acc.Email, name)
				projectId = p.pollOnboardLRO(token, name, acc.Email)
			}
		}
	}

	if projectId == "" {
		return fmt.Errorf("onboardUser returned no projectId")
	}

	// 更新账号
	p.mu.Lock()
	if entry, ok := p.accounts[acc.ID]; ok {
		entry.ProjectId = projectId
	}
	p.mu.Unlock()
	acc.ProjectId = projectId

	go p.SaveAccounts()
	return nil
}

// extractProjectIdFromOnboard 从 onboardUser 响应中提取 projectId
func extractProjectIdFromOnboard(data map[string]interface{}) string {
	// 可能直接在 response 中
	response := data
	if r, ok := data["response"].(map[string]interface{}); ok {
		response = r
	}

	projectObj, ok := response["cloudaicompanionProject"].(map[string]interface{})
	if !ok {
		return ""
	}

	// 尝试多个可能的字段名
	for _, key := range []string{"projectId", "project", "id", "name"} {
		if v, ok := projectObj[key].(string); ok && v != "" {
			// 清理 projects/ 前缀
			v = strings.TrimPrefix(v, "projects/")
			if v != "" {
				return v
			}
		}
	}
	return ""
}

// pollOnboardLRO 轮询 onboardUser 的长轮询操作
func (p *AccountPool) pollOnboardLRO(token string, operationName string, email string) string {
	for attempt := 1; attempt <= 15; attempt++ {
		time.Sleep(800 * time.Millisecond)

		apiUrl := DailyCloudEndpoint + "/v1/" + operationName
		req, err := http.NewRequest("GET", apiUrl, nil)
		if err != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := p.httpClient.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			continue
		}

		var result map[string]interface{}
		if json.Unmarshal(body, &result) != nil {
			continue
		}

		done, _ := result["done"].(bool)
		if done {
			Log("[quota-refresh] %s: LRO completed after %d poll(s)", email, attempt)
			return extractProjectIdFromOnboard(result)
		}
	}
	return ""
}

// refreshAccountQuota 对单个账号调用 fetchAvailableModels 获取额度快照
func (p *AccountPool) refreshAccountQuota(acc *AccountEntry) error {
	// 刷新 access token
	token, err := p.GetAccessToken(acc.ID)
	if err != nil {
		return fmt.Errorf("token refresh: %w", err)
	}
	if acc.ProjectId == "" {
		return fmt.Errorf("no projectId")
	}

	// 调用 fetchAvailableModels API
	reqBody, _ := json.Marshal(map[string]string{"project": acc.ProjectId})
	apiUrl := DailyCloudEndpoint + "/v1internal:fetchAvailableModels"
	req, err := http.NewRequest("POST", apiUrl, io.NopCloser(strings.NewReader(string(reqBody))))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "google-antigravity-ls/1.26.0")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("API request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body[:min(len(body), 200)]))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	// 解析模型列表并生成额度分组
	Log("[quota-refresh] %s: got %d bytes response", acc.Email, len(body))
	groups := parseModelsResponse(body)
	Log("[quota-refresh] %s: parsed %d quota groups", acc.Email, len(groups))

	p.mu.Lock()
	if entry, ok := p.accounts[acc.ID]; ok {
		entry.quotaGroups = groups
		entry.quotaRefreshedAt = time.Now()
	}
	p.mu.Unlock()

	return nil
}

// parseModelsResponse 解析 fetchAvailableModels 的响应，提取模型额度信息
// 实际 API 返回格式:
//
//	{
//	  "models": {
//	    "gemini-2.5-pro": { "quotaInfo": { "remainingFraction": 0.85 } },
//	    "claude-sonnet-4": { "quotaInfo": { "remainingFraction": 0.0 } }
//	  }
//	}
//
// models 是 Object（key→value map），不是数组！
// 额度字段是 quotaInfo.remainingFraction（0.0-1.0 的小数）
func parseModelsResponse(body []byte) []QuotaGroup {
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		Log("[quota-refresh] Failed to parse response: %v", err)
		return nil
	}

	modelsRaw, ok := raw["models"]
	if !ok {
		Log("[quota-refresh] Response has no 'models' field")
		return nil
	}

	// models 可能是 Object 或 null
	modelsMap, ok := modelsRaw.(map[string]interface{})
	if !ok || len(modelsMap) == 0 {
		Log("[quota-refresh] 'models' is not a map or is empty")
		return nil
	}

	Log("[quota-refresh] Parsing %d models from response", len(modelsMap))

	// 按 provider 分组
	providerEntries := make(map[string][]QuotaEntry)
	for modelKey, modelDataRaw := range modelsMap {
		modelData, ok := modelDataRaw.(map[string]interface{})
		if !ok {
			continue
		}

		// 提取 quotaInfo.remainingFraction
		var fraction float64 = -1 // -1 表示无数据
		if qi, ok := modelData["quotaInfo"].(map[string]interface{}); ok {
			if rf, ok := qi["remainingFraction"].(float64); ok {
				fraction = rf
			}
		}

		percent := 0.0
		isBlocked := false
		if fraction >= 0 {
			percent = fraction * 100 // 转换为百分比
			isBlocked = fraction <= 0
		}

		provider := classifyProvider(modelKey)
		entry := QuotaEntry{
			Key:       modelKey,
			Label:     modelKey,
			Percent:   percent,
			IsBlocked: isBlocked,
			Provider:  provider,
		}

		// 尝试从 modelData 中获取 displayName
		if dn, ok := modelData["displayName"].(string); ok && dn != "" {
			entry.Label = dn
		}

		providerEntries[provider] = append(providerEntries[provider], entry)
	}

	// 构建 QuotaGroup
	var groups []QuotaGroup
	providerOrder := []string{"gemini", "claude", "gpt"}
	for _, prov := range providerOrder {
		entries, ok := providerEntries[prov]
		if !ok {
			continue
		}
		blocked := 0
		totalPercent := 0.0
		for _, e := range entries {
			if e.IsBlocked {
				blocked++
			}
			totalPercent += e.Percent
		}
		avgPercent := totalPercent / float64(len(entries))

		groups = append(groups, QuotaGroup{
			Provider:     prov,
			Percent:      avgPercent,
			ModelCount:   len(entries),
			BlockedCount: blocked,
			Entries:      entries,
		})
	}

	return groups
}

// classifyProvider 将模型名分类为厂商族 gemini/claude/gpt。复用唯一的分类真源
// modelFamily(product_bucket.go),与服务端 billing 保持一致,不再各写一套特判。
func classifyProvider(modelName string) string {
	return modelFamily(modelName)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ─── 请求后自动刷新 ─────────────────────────────────────────────────────

// PostRequestHealthRefresh 请求成功后异步刷新账号的积分和模型额度
// CAS 保护：同一账号同时只允许一个刷新任务
func (p *AccountPool) PostRequestHealthRefresh(accountId int) {
	p.mu.RLock()
	acc, ok := p.accounts[accountId]
	p.mu.RUnlock()

	if !ok || !acc.Enabled {
		return
	}

	// CAS 防并发
	if !atomic.CompareAndSwapInt32(&acc.healthRefreshing, 0, 1) {
		return
	}

	go func() {
		defer atomic.StoreInt32(&acc.healthRefreshing, 0)

		// 自动发现 projectId（如果没有）
		if acc.ProjectId == "" {
			if err := p.discoverProjectId(acc); err != nil {
				Log("[post-req-refresh] %s: project discovery failed: %v", acc.Email, err)
				return
			}
		}

		// 1. loadCodeAssist → 积分 + 套餐
		if err := p.fetchAccountHealth(acc); err != nil {
			Log("[post-req-refresh] %s: health failed: %v", acc.Email, err)
		}

		// 2. fetchAvailableModels → 模型额度
		if err := p.refreshAccountQuota(acc); err != nil {
			Log("[post-req-refresh] %s: quota failed: %v", acc.Email, err)
		} else {
			Log("[post-req-refresh] %s: refreshed OK", acc.Email)
		}
	}()
}

// ─── 前端展示（本地号池） ────────────────────────────────────────────────

// ActiveAccountSummary 当前活跃账号的额度摘要（给前端展示用）
type ActiveAccountSummary struct {
	AccountId       int          `json:"accountId"`
	Email           string       `json:"email"`
	Alias           string       `json:"alias,omitempty"`
	PlanType        string       `json:"planType"`
	Credits         *CreditsInfo `json:"credits,omitempty"`
	QuotaGroups     []QuotaGroup `json:"quotaGroups,omitempty"`
	QuotaRefreshedAt int64       `json:"quotaRefreshedAt"`
}

// GetActiveAccountInfo 返回当前活跃账号的额度信息（只读快照）
func (p *AccountPool) GetActiveAccountInfo() *ActiveAccountSummary {
	p.mu.RLock()
	defer p.mu.RUnlock()

	activeId := p.activeAccountId
	if activeId == 0 {
		return nil
	}

	acc, ok := p.accounts[activeId]
	if !ok {
		return nil
	}

	summary := &ActiveAccountSummary{
		AccountId:        acc.ID,
		Email:            maskEmail(acc.Email),
		Alias:            acc.Alias,
		PlanType:         acc.PlanType,
		QuotaGroups:      acc.quotaGroups,
		QuotaRefreshedAt: acc.quotaRefreshedAt.UnixMilli(),
	}

	if acc.creditsKnown {
		summary.Credits = &CreditsInfo{
			Known:           true,
			Available:       acc.creditsAvailable,
			CreditAmount:    acc.creditAmount,
			MinCreditAmount: acc.minCreditAmount,
			PaidTierID:      acc.paidTierID,
		}
	}

	return summary
}
