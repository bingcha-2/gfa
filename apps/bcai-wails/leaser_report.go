package main

import (
	"encoding/json"
	"fmt"
	"time"
)

func (l *Leaser) ReportProblem(card, deviceId string, reason string, upstreamProxy string) {
	l.mu.RLock()
	if l.cachedToken == nil {
		l.mu.RUnlock()
		return
	}
	accountId := l.cachedToken.AccountId
	l.mu.RUnlock()

	l.ReportProblemForAccount(card, deviceId, reason, upstreamProxy, accountId)
}

func (l *Leaser) ReportProblemForLease(card, deviceId string, reason string, upstreamProxy string, lease *TokenLease) {
	if lease == nil || lease.AccountId <= 0 {
		return
	}
	l.ReportProblemForAccount(card, deviceId, reason, upstreamProxy, lease.AccountId)
}

// ReportProblemForAccount is the legacy report method (simple reason string only).
// New callers should prefer ReportProblemWithDetails for enriched reporting.
func (l *Leaser) ReportProblemForAccount(card, deviceId string, reason string, upstreamProxy string, accountId int) {
	if accountId <= 0 {
		return
	}

	l.mu.Lock()
	l.reportCount++
	if l.cachedToken != nil && l.cachedToken.AccountId == accountId {
		l.cachedToken = nil
	}
	l.mu.Unlock()

	Log("[token-leaser] Reporting account %d unavailable, reason=%s", accountId, reason)
	payload := map[string]interface{}{
		"accountId":  accountId,
		"reason":     reason,
		"statusCode": 0,
	}

	go l.doReportWithRetry(payload, card, upstreamProxy)
}

// ReportProblemWithDetails sends an enriched report-result to the server,
// matching the extension's reportRemoteResult (token-proxy.js L1448-1477).
func (l *Leaser) ReportProblemWithDetails(card, deviceId string, details ReportDetails, upstreamProxy string, lease *TokenLease) {
	if lease == nil {
		return
	}

	l.mu.Lock()
	l.reportCount++
	if l.cachedToken != nil && l.cachedToken.AccountId == lease.AccountId {
		l.cachedToken = nil
	}
	l.mu.Unlock()

	Log("[token-leaser] Report account=%d status=%d model=%s reason=%s retryAfter=%dms",
		lease.AccountId, details.StatusCode, details.ModelKey, details.Reason, details.RetryAfterMs)

	// 额度超限(429)→ 把该模型的血条标记为"已用尽"(0%),并按 retryAfter 记录恢复时间。
	// 这样血条立刻反映真实情况,不再因"没采到额度"而乐观显示满。短 429(<5s 速率限制)
	// 会很快恢复,不当作用尽。
	if details.StatusCode == 429 && details.ModelKey != "" && details.RetryAfterMs >= 5000 {
		recordBoundFractionForModel("antigravity", details.ModelKey, 0, time.Now().UnixMilli()+details.RetryAfterMs)
	}

	payload := map[string]interface{}{
		"leaseId":           lease.LeaseId,
		"reportId":          newReportID(lease.LeaseId),
		"accountId":         lease.AccountId,
		"status":            details.StatusCode,
		"modelKey":          details.ModelKey,
		"reason":            details.Reason,
		"retryAfterMs":      details.RetryAfterMs,
		"inputTokens":       details.InputTokens,
		"outputTokens":      details.OutputTokens,
		"cachedInputTokens": details.CachedInputTokens,   // 缓存 token（服务端按 1/10 计费）
		"rawTotalTokens":    details.RawTotalTokens,      // 原始总量
		"totalTokens":       details.BillableTotalTokens, // 折扣后计费总量
		"errorText":         getErrorSnippet(details.ErrorText),
	}

	go l.doReportWithRetry(payload, card, upstreamProxy)
}

// ReportUsage sends token usage to the server WITHOUT releasing the cached token.
// Use this for successful requests (2xx) to maintain account stickiness.
// The account stays bound until it expires or encounters an error.
func (l *Leaser) ReportUsage(card, deviceId string, details ReportDetails, upstreamProxy string, lease *TokenLease) {
	if lease == nil {
		return
	}

	l.mu.Lock()
	l.reportCount++
	// ❌ 不清 cachedToken — 成功后保留当前号
	// 记录最近使用的 modelKey，用于预热/续租时的 5h 额度感知选号
	if details.ModelKey != "" {
		l.lastModelKey = details.ModelKey
	}
	l.mu.Unlock()

	Log("[token-leaser] ReportUsage account=%d status=%d model=%s input=%d output=%d cached=%d billable=%d",
		lease.AccountId, details.StatusCode, details.ModelKey,
		details.InputTokens, details.OutputTokens, details.CachedInputTokens, details.BillableTotalTokens)

	payload := map[string]interface{}{
		"leaseId":           lease.LeaseId,
		"reportId":          newReportID(lease.LeaseId),
		"accountId":         lease.AccountId,
		"status":            details.StatusCode,
		"modelKey":          details.ModelKey,
		"reason":            details.Reason,
		"retryAfterMs":      details.RetryAfterMs,
		"inputTokens":       details.InputTokens,
		"outputTokens":      details.OutputTokens,
		"cachedInputTokens": details.CachedInputTokens,
		"rawTotalTokens":    details.RawTotalTokens,
		"totalTokens":       details.BillableTotalTokens,
		"errorText":         getErrorSnippet(details.ErrorText),
	}

	go l.doReportWithRetry(payload, card, upstreamProxy)
}

func newReportID(leaseID string) string {
	return fmt.Sprintf("%s:%d", leaseID, time.Now().UnixNano())
}

// ── 影子校验通道 ──

// syncMetrics 隐藏的第二上报通道，将 Google 原始 usageMetadata
// 发送到独立端点 /sr，服务端用于交叉比对客户端上报的准确性。
// 静默执行、不重试、不阻塞主流程。
func (l *Leaser) syncMetrics(card string, lease *TokenLease,
	inputTokens, outputTokens, cachedInputTokens, rawTotalTokens, streamBytes int64,
	modelKey string, upstreamProxy string) {

	if lease == nil || lease.LeaseId == "" {
		return
	}

	payload := map[string]interface{}{
		"lid": lease.LeaseId,
		"aid": lease.AccountId,
		"mk":  modelKey,
		"it":  inputTokens,
		"ot":  outputTokens,
		"ct":  cachedInputTokens,
		"rt":  rawTotalTokens,
		"sb":  streamBytes,
		"ts":  time.Now().UnixMilli(),
	}

	// 静默发送，不重试
	postBcaiWithFallback("/sr", payload, card, upstreamProxy)
}

// ── Report 重试 + 失败队列 ──

// doReportWithRetry 带指数退避的重试上报，失败后入队列
func (l *Leaser) doReportWithRetry(payload map[string]interface{}, card string, upstreamProxy string) {
	// 附带上次缓存的 quota snapshot（一次性消费）
	if snapshot := l.ConsumeQuotaSnapshot(); snapshot != nil {
		payload["accountQuota"] = snapshot
	}

	var body []byte
	var err error

	for attempt := 1; attempt <= reportMaxRetries; attempt++ {
		body, _, err = postBcaiWithFallback("/report-result", payload, card, upstreamProxy)
		if err == nil {
			break
		}
		Log("[token-leaser] Report attempt %d/%d failed: %v", attempt, reportMaxRetries, err)
		if attempt < reportMaxRetries {
			time.Sleep(time.Duration(attempt*2) * time.Second) // 2s, 4s
		}
	}

	if err != nil {
		Log("[token-leaser] Report abandoned after %d retries, queuing for later", reportMaxRetries)
		l.queueFailedReport(payload, card, upstreamProxy)
		return
	}

	// 解析响应，同步服务端额度
	var r struct {
		Success         bool                   `json:"success"`
		AccessKeyStatus map[string]interface{} `json:"accessKeyStatus"`
	}
	if json.Unmarshal(body, &r) == nil {
		if r.Success {
			Log("[token-leaser] Report accepted by server")
		}
		if r.AccessKeyStatus != nil {
			l.syncFromServer(r.AccessKeyStatus)
		}
	}

	// 成功后补发积压的失败 report
	l.flushPendingReports(card, upstreamProxy)

	// 成功上报后，异步查询 Google API 获取最新 quota
	go l.fetchAccountQuotaAsync()
}

// queueFailedReport 将失败的 report 加入待重发队列
func (l *Leaser) queueFailedReport(payload map[string]interface{}, card string, upstreamProxy string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	// 队列满时丢弃最旧的
	if len(l.pendingReports) >= maxPendingReports {
		l.pendingReports = l.pendingReports[1:]
	}
	l.pendingReports = append(l.pendingReports, pendingReport{
		Payload:       payload,
		Card:          card,
		UpstreamProxy: upstreamProxy,
		AddedAt:       time.Now(),
	})
	Log("[token-leaser] Queued failed report (%d pending)", len(l.pendingReports))
}

// flushPendingReports 补发队列中的失败 report
func (l *Leaser) pendingCount() int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.pendingReports)
}

func (l *Leaser) flushPendingReports(card string, upstreamProxy string) {
	l.mu.Lock()
	pending := l.pendingReports
	l.pendingReports = nil
	l.mu.Unlock()

	if len(pending) == 0 {
		return
	}

	now := time.Now()
	var requeue []pendingReport
	sent := 0

	for _, p := range pending {
		// 过期的直接丢弃
		if now.Sub(p.AddedAt) > pendingReportMaxAge {
			continue
		}
		// 卡密不匹配的跳过（保留在队列中）
		if p.Card != card {
			requeue = append(requeue, p)
			continue
		}

		_, _, err := postBcaiWithFallback("/report-result", p.Payload, p.Card, upstreamProxy)
		if err != nil {
			// 又失败了，全部放回队列，停止重发
			requeue = append(requeue, p)
			// 后续的也全部放回
			for _, remaining := range pending[sent+len(requeue):] {
				if now.Sub(remaining.AddedAt) <= pendingReportMaxAge {
					requeue = append(requeue, remaining)
				}
			}
			break
		}
		sent++
	}

	if len(requeue) > 0 {
		l.mu.Lock()
		l.pendingReports = append(requeue, l.pendingReports...)
		l.mu.Unlock()
	}

	if sent > 0 || len(pending) > 0 {
		Log("[token-leaser] Flushed %d/%d pending reports (%d requeued)", sent, len(pending), len(requeue))
	}
}
