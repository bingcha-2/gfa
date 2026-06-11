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
	}
	if json.Unmarshal(body, &resp) != nil || len(resp.FairShareQuota) == 0 {
		return
	}
	for bucket, q := range resp.FairShareQuota {
		recordMyBucketFraction(bucket, q.Fraction, q.ResetAt)
	}
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

// leaserReadyWithoutAntigravity 判断卡「已明确开通产品、但不含 antigravity」。
// 这类卡(claude-only / codex-only 绑定卡)不会去租 antigravity,主 cachedToken 恒为
// nil,故不能据此判定「还在等首租」。products 为空(池子卡=不限产品,覆盖 antigravity)
// 时返回 false —— 它仍需等 antigravity 首租,保持原行为。无锁直读(调用方已持 RLock)。
func leaserReadyWithoutAntigravity(aks map[string]interface{}) bool {
	raw, ok := aks["products"].([]interface{})
	if !ok || len(raw) == 0 {
		return false
	}
	for _, v := range raw {
		if s, _ := v.(string); s == "antigravity" {
			return false
		}
	}
	return true
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

	state := "waiting_first_lease"
	if hasToken {
		state = "ready"
	} else if l.lastError != "" {
		state = "error"
	} else if leaserReadyWithoutAntigravity(l.accessKeyStatus) {
		// 该卡未开通 antigravity:主(antigravity)租号被有意跳过(见 prewarm 的
		// "本卡未开通 Antigravity,跳过"),cachedToken 恒为 nil —— 不代表还在等首租。
		// codex/claude 按需租号,代理已就绪。否则 claude/codex-only 绑定卡会永远卡在
		// 「获取租约中…」。
		state = "ready"
	}

	// Dynamically adjust tokenWindowResetMs to account for elapsed time
	aks := l.accessKeyStatus
	if aks != nil && !l.accessKeyStatusAt.IsZero() {
		elapsed := time.Since(l.accessKeyStatusAt).Milliseconds()
		// Make a shallow copy to avoid mutating the cached map
		aksAdj := make(map[string]interface{}, len(aks))
		for k, v := range aks {
			aksAdj[k] = v
		}
		if resetMs, ok := aks["tokenWindowResetMs"]; ok {
			if rmf, ok := resetMs.(float64); ok {
				adj := rmf - float64(elapsed)
				if adj < 0 {
					adj = 0
				}
				aksAdj["tokenWindowResetMs"] = adj
			}
		}
		aks = aksAdj
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
