package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ── 本地计费函数 ──

func isGeminiModel(modelKey string) bool {
	lower := strings.ToLower(modelKey)
	return strings.Contains(lower, "gemini") || strings.HasPrefix(lower, "gem")
}

// RecordLocalUsage 每次请求完成后调用，本地累加 token 用量
func (l *Leaser) RecordLocalUsage(modelKey string, billableTokens int64) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now().UnixMilli()
	wMs := l.localQuota.WindowMs
	if wMs <= 0 {
		wMs = defaultWindowMs
	}

	// 窗口过期 → 重置
	if l.localQuota.WindowStartedAt > 0 && now > l.localQuota.WindowStartedAt+wMs {
		l.localQuota.OpusTokensUsed = 0
		l.localQuota.GeminiTokensUsed = 0
		l.localQuota.CodexTokensUsed = 0
		l.localQuota.WindowStartedAt = now
	}
	// 首次使用 → 初始化窗口
	if l.localQuota.WindowStartedAt == 0 {
		l.localQuota.WindowStartedAt = now
	}

	// 分桶与服务端 UNIVERSAL_BILLING 一致:gemini / codex / opus(其它)。
	if isGeminiModel(modelKey) {
		l.localQuota.GeminiTokensUsed += billableTokens
	} else if isCodexModel(modelKey) {
		l.localQuota.CodexTokensUsed += billableTokens
	} else {
		l.localQuota.OpusTokensUsed += billableTokens
	}
}

// isCodexModel 与服务端一致:gpt-* 或 *-codex。
func isCodexModel(modelKey string) bool {
	k := strings.ToLower(modelKey)
	return strings.HasPrefix(k, "gpt") || strings.Contains(k, "codex")
}

// formatTokens 把 token 数格式化为 K/M/B 阶梯(最小单位 K,<1K 也显示 0.xxK)。
// 整数不带小数,非整数保留两位小数;0 → "0"。与前端 lib/utils.ts 口径一致。
// 例:842→"0.84K" · 1200→"1.20K" · 12000→"12K" · 1.50M · 3.45B
func formatTokens(n int64) string {
	if n <= 0 {
		return "0"
	}
	v, unit := float64(n)/1000, "K"
	switch {
	case n >= 1_000_000_000:
		v, unit = float64(n)/1e9, "B"
	case n >= 1_000_000:
		v, unit = float64(n)/1e6, "M"
	}
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d%s", int64(v), unit)
	}
	return fmt.Sprintf("%.2f%s", v, unit)
}

// CheckLocalQuota 在 lease 之前调用，检查本地额度是否充足
// 返回 (ok, waitMs, reason)
func (l *Leaser) CheckLocalQuota(modelKey string) (bool, int64, string) {
	l.mu.RLock()
	defer l.mu.RUnlock()

	// dynamic/unlimited 模式：由服务端 fair-share + 上游窗口控制，客户端不做本地拦截
	if l.quotaMode == "dynamic" || l.quotaMode == "unlimited" {
		return true, 0, ""
	}

	q := l.localQuota
	if q.OpusTokenLimit <= 0 && q.GeminiTokenLimit <= 0 {
		return true, 0, "" // 首次无限额 → 放行
	}

	now := time.Now().UnixMilli()
	wMs := q.WindowMs
	if wMs <= 0 {
		wMs = defaultWindowMs
	}

	// 窗口过期 → 放行
	if q.WindowStartedAt > 0 && now > q.WindowStartedAt+wMs {
		return true, 0, ""
	}

	// 计算剩余恢复时间
	var resetMs int64
	if q.WindowStartedAt > 0 {
		resetMs = q.WindowStartedAt + wMs - now
		if resetMs < 0 {
			resetMs = 0
		}
	}

	if isGeminiModel(modelKey) {
		if q.GeminiTokenLimit > 0 && q.GeminiTokensUsed >= q.GeminiTokenLimit {
			return false, resetMs, fmt.Sprintf(
				"Gemini 额度已用尽 (%s/%s)，%d分钟后恢复",
				formatTokens(q.GeminiTokensUsed), formatTokens(q.GeminiTokenLimit), resetMs/60000)
		}
	} else {
		if q.OpusTokenLimit > 0 && q.OpusTokensUsed >= q.OpusTokenLimit {
			return false, resetMs, fmt.Sprintf(
				"Opus 额度已用尽 (%s/%s)，%d分钟后恢复",
				formatTokens(q.OpusTokensUsed), formatTokens(q.OpusTokenLimit), resetMs/60000)
		}
	}
	return true, 0, ""
}

// syncFromServer 用服务端返回的 accessKeyStatus 校准本地额度
func (l *Leaser) syncFromServer(aks map[string]interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.accessKeyStatus = aks
	l.accessKeyStatusAt = time.Now()

	// 读取额度模式
	if mode, ok := aks["quotaMode"].(string); ok {
		l.quotaMode = mode
	}

	// 限额以服务端为准 — 包括 0（无限制 / 动态模式清零）
	if v, ok := aks["opusTokenLimit"].(float64); ok {
		l.localQuota.OpusTokenLimit = int64(v)
	}
	if v, ok := aks["geminiTokenLimit"].(float64); ok {
		l.localQuota.GeminiTokenLimit = int64(v)
	}
	if v, ok := aks["codexTokenLimit"].(float64); ok {
		l.localQuota.CodexTokenLimit = int64(v)
	}
	// tokenWindowLimit fallback 只在 static 模式下补位
	if l.quotaMode == "static" || l.quotaMode == "" {
		if v, ok := aks["tokenWindowLimit"].(float64); ok && v > 0 {
			baseLimit := int64(v)
			if l.localQuota.OpusTokenLimit <= 0 {
				l.localQuota.OpusTokenLimit = baseLimit
			}
			if l.localQuota.GeminiTokenLimit <= 0 {
				l.localQuota.GeminiTokenLimit = baseLimit * 5
			}
			if l.localQuota.CodexTokenLimit <= 0 {
				l.localQuota.CodexTokenLimit = baseLimit
			}
		}
	}
	if v, ok := aks["tokenWindowMs"].(float64); ok && v > 0 {
		l.localQuota.WindowMs = int64(v)
	}
	// 已用量取 max(本地, 服务端)
	if v, ok := aks["opusTokensUsed"].(float64); ok && int64(v) > l.localQuota.OpusTokensUsed {
		l.localQuota.OpusTokensUsed = int64(v)
	}
	if v, ok := aks["geminiTokensUsed"].(float64); ok && int64(v) > l.localQuota.GeminiTokensUsed {
		l.localQuota.GeminiTokensUsed = int64(v)
	}
	if v, ok := aks["codexTokensUsed"].(float64); ok && int64(v) > l.localQuota.CodexTokensUsed {
		l.localQuota.CodexTokensUsed = int64(v)
	}
	// 反推窗口起始时间
	if v, ok := aks["tokenWindowResetMs"].(float64); ok && v > 0 {
		wMs := l.localQuota.WindowMs
		if wMs <= 0 {
			wMs = defaultWindowMs
		}
		l.localQuota.WindowStartedAt = time.Now().UnixMilli() + int64(v) - wMs
	}
}

// recordAccountBuckets 解析 lease 响应里的 accountBuckets(绑定号已知的各 bucket 额度),
// 一次性记录所有 bucket,让激活/预热那一下每条血条都有真实值。
func recordAccountBuckets(body []byte) {
	var resp struct {
		AccountBuckets map[string]struct {
			Fraction float64 `json:"fraction"`
			ResetAt  int64   `json:"resetAt"`
		} `json:"accountBuckets"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return
	}
	for bucket, q := range resp.AccountBuckets {
		recordAccountBucketFraction(bucket, q.Fraction, q.ResetAt)
	}
}

// recordFairShareQuota 解析 lease 响应里的 fairShareQuota(绑定卡的均分额度剩余)。
// 当存在时,覆盖 accountBuckets 写入的值——血条显示的是"这张卡的公平份额剩余",
// 而不是"整个账号剩余"。这样多卡拼车时,每张卡看到自己独立的进度条。
func recordFairShareQuota(body []byte) {
	var resp struct {
		FairShareQuota map[string]struct {
			Fraction float64 `json:"fraction"`
			ResetAt  int64   `json:"resetAt"`
		} `json:"fairShareQuota"`
		// 周血条:与 fairShareQuota 平行,同 bucket 键(仅 codex/anthropic 下发;旧服务端无此字段)。
		WeeklyFairShareQuota map[string]struct {
			Fraction float64 `json:"fraction"`
			ResetAt  int64   `json:"resetAt"`
		} `json:"weeklyFairShareQuota"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return
	}
	for bucket, q := range resp.FairShareQuota {
		recordMyBucketFraction(bucket, q.Fraction, q.ResetAt)
	}
	for bucket, q := range resp.WeeklyFairShareQuota {
		recordMyWeeklyBucketFraction(bucket, q.Fraction, q.ResetAt)
	}
}

func syncQuotaStateFromBody(l *Leaser, body []byte) {
	recordAccountBuckets(body)
	recordFairShareQuota(body)
	var raw map[string]interface{}
	if json.Unmarshal(body, &raw) != nil {
		return
	}
	if aks, ok := raw["accessKeyStatus"]; ok {
		if aksMap, ok := aks.(map[string]interface{}); ok {
			l.syncFromServer(aksMap)
		}
	}
}

func cloneAccessKeyStatusWithElapsed(aks map[string]interface{}, elapsedMs int64) map[string]interface{} {
	if aks == nil {
		return nil
	}
	out := make(map[string]interface{}, len(aks))
	for k, v := range aks {
		out[k] = v
	}
	adjust := func(msKey, atKey string) {
		raw, ok := aks[msKey]
		if !ok {
			return
		}
		rmf, ok := raw.(float64)
		if !ok {
			return
		}
		adj := rmf - float64(elapsedMs)
		if adj < 0 {
			adj = 0
		}
		out[msKey] = adj
		if atKey != "" {
			if adj <= 0 {
				out[atKey] = ""
			} else {
				out[atKey] = time.Now().Add(time.Duration(adj) * time.Millisecond).Format(time.RFC3339)
			}
		}
	}
	adjust("tokenWindowResetMs", "tokenWindowResetAt")
	adjust("weeklyWindowResetMs", "weeklyWindowResetAt")
	if rawBuckets, ok := aks["weeklyBuckets"].([]interface{}); ok {
		buckets := make([]interface{}, len(rawBuckets))
		for i, item := range rawBuckets {
			m, ok := item.(map[string]interface{})
			if !ok {
				buckets[i] = item
				continue
			}
			m2 := make(map[string]interface{}, len(m))
			for k, v := range m {
				m2[k] = v
			}
			if raw, ok := m["weeklyWindowResetMs"]; ok {
				if rmf, ok := raw.(float64); ok {
					adj := rmf - float64(elapsedMs)
					if adj < 0 {
						adj = 0
					}
					m2["weeklyWindowResetMs"] = adj
					if adj <= 0 {
						m2["weeklyWindowResetAt"] = ""
					} else {
						m2["weeklyWindowResetAt"] = time.Now().Add(time.Duration(adj) * time.Millisecond).Format(time.RFC3339)
					}
				}
			}
			buckets[i] = m2
		}
		out["weeklyBuckets"] = buckets
	}
	return out
}

// boundResetMs 把绑定号上游重置的绝对时间(epoch ms)换算成剩余毫秒;0 表示未知。
func boundResetMs(resetAt int64) int64 {
	if resetAt <= 0 {
		return 0
	}
	rem := resetAt - time.Now().UnixMilli()
	if rem < 0 {
		return 0
	}
	return rem
}

func (l *Leaser) GetStatus() map[string]interface{} {
	l.mu.RLock()
	defer l.mu.RUnlock()

	hasToken := l.cachedToken != nil
	var projectId string
	var accountId interface{} = nil
	var expiresAtStr interface{} = nil

	if hasToken {
		projectId = l.cachedToken.ProjectId
		accountId = l.cachedToken.AccountId
		expiresAtStr = time.Unix(0, l.cachedToken.ExpiresAt*int64(time.Millisecond)).Format(time.RFC3339)
	}

	// serviceState 驱动前端 StatusPill。默认 waiting_first_lease(=「获取租约中…」)只在
	// 「确实还在等首个 antigravity 租约」时成立 —— 否则会把「卡不可用」「未开 antigravity」
	// 这些 cachedToken 恒为 nil 的稳态也误显示成永久「获取租约中…」。
	state := "waiting_first_lease"
	switch {
	case hasToken:
		state = "ready"
	case l.cardUnusable:
		// 卡密不可用(订阅到期/无生效订阅):别报「获取租约中…」,前端据 cardUnusable
		// 显示「订阅已到期」横幅 + StatusPill。
		state = "error"
	case l.lastError != "":
		state = "error"
	case decideAntigravity(l.entitlementsKnown, l.entitledProducts, l.subActive, productsFromAKS(l.accessKeyStatus)) == agSkip:
		// 有生效订阅、但未开 antigravity:主 antigravity 租号被有意跳过(见 StartAutoLease
		// 的「本卡未开通 Antigravity,跳过」),cachedToken 恒为 nil —— 不代表还在等首租。
		// codex/claude 按需租号、代理已就绪。用授权(entitledProducts,心跳已 seed)判定,
		// 不再只看 accessKeyStatus —— 否则只开 codex/anthropic 的卡冷启动会永远卡「获取租约中…」。
		state = "ready"
	}

	// Dynamically adjust token/weekly reset counters to account for elapsed time.
	aks := l.accessKeyStatus
	if aks != nil && !l.accessKeyStatusAt.IsZero() {
		aks = cloneAccessKeyStatusWithElapsed(aks, time.Since(l.accessKeyStatusAt).Milliseconds())
	}

	// 本地额度剩余恢复时间
	var localResetMs int64
	wMs := l.localQuota.WindowMs
	if wMs <= 0 {
		wMs = defaultWindowMs
	}
	if l.localQuota.WindowStartedAt > 0 {
		localResetMs = l.localQuota.WindowStartedAt + wMs - time.Now().UnixMilli()
		if localResetMs < 0 {
			localResetMs = 0
		}
	}

	return map[string]interface{}{
		"quotaMode":           l.quotaMode,
		"hasToken":            hasToken,
		"serviceState":        state,
		"projectId":           projectId,
		"accountId":           accountId,
		"expiresAt":           expiresAtStr,
		"leaseCount":          l.leaseCount,
		"reportCount":         l.reportCount,
		"lastError":           l.lastError,
		"activationExpiresAt": l.cardExpires,
		"autoLeaseRunning":    l.leaseRunning,
		"cardUnusable":        l.cardUnusable,
		"boundResetMs":        boundResetMs(l.boundResetAt),
		"accessKeyStatus":     aks,
		"localQuota": map[string]interface{}{
			"opusTokensUsed":   l.localQuota.OpusTokensUsed,
			"opusTokenLimit":   l.localQuota.OpusTokenLimit,
			"geminiTokensUsed": l.localQuota.GeminiTokensUsed,
			"geminiTokenLimit": l.localQuota.GeminiTokenLimit,
			"codexTokensUsed":  l.localQuota.CodexTokensUsed,
			"codexTokenLimit":  l.localQuota.CodexTokenLimit,
			"windowResetMs":    localResetMs,
			"windowMs":         wMs,
			"pendingReports":   len(l.pendingReports),
		},
	}
}
