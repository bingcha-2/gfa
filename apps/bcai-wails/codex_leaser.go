package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

var CODEX_API_BASE = getEnvOrDefault("BCAI_CODEX_API_BASE", "https://bcai.site/remote-codex")

type CodexTokenLease struct {
	AccessToken string `json:"accessToken"`
	AccountId   int    `json:"accountId"`
	LeaseId     string `json:"leaseId"`
	EmailHint   string `json:"emailHint"`
	ExpiresAt   int64  `json:"expiresAt"`
	LeasedAt    int64  `json:"leasedAt"`
}

type codexLeaseTokenResp struct {
	Success     *bool           `json:"success"`
	Ok          *bool           `json:"ok"`
	Code        string          `json:"code"`
	Message     string          `json:"message"`
	Error       string          `json:"error"`
	AccessToken string          `json:"accessToken"`
	AccountId   json.RawMessage `json:"accountId"`
	LeaseId     string          `json:"leaseId"`
	EmailHint   string          `json:"emailHint"`
	ExpiresAt   string          `json:"expiresAt"`
}

type CodexLeaser struct {
	lastError string

	mu             sync.Mutex
	cachedQuota    *CodexAccountQuotaSnapshot // one-shot snapshot for the next report
	quotaFetching  int32                      // CAS guard for fetchCodexQuotaAsync
	pendingReports []pendingReport            // 失败上报队列(对齐 Gemini,防丢用量)
}

var globalCodexLeaser = &CodexLeaser{}

func GetCodexLeaser() *CodexLeaser {
	return globalCodexLeaser
}

// setLastError / LastError guard lastError with l.mu. LeaseToken/Activate run once
// per inbound proxy request and are therefore called concurrently across goroutines;
// every other CodexLeaser field is mutex-guarded, so lastError must be too (otherwise
// `go test -race` flags an unsynchronized write/read on a shared string).
func (l *CodexLeaser) setLastError(msg string) {
	l.mu.Lock()
	l.lastError = msg
	l.mu.Unlock()
}

func (l *CodexLeaser) LastError() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastError
}

func postCodexBcai(path string, payload interface{}, secret string, upstreamProxy string) ([]byte, int, error) {
	respBody, status, err := postBcaiBaseWithFallback(CODEX_API_BASE, path, payload, secret, upstreamProxy)
	if err != nil {
		return respBody, status, err
	}
	if status >= 400 {
		return respBody, status, fmt.Errorf("remote codex status %d: %s", status, string(respBody))
	}
	return respBody, status, nil
}

func (l *CodexLeaser) Activate(card, deviceId string, upstreamProxy string) (string, error) {
	payload := map[string]string{
		"accountCard": card,
		"deviceId":    deviceId,
	}
	body, _, err := postCodexBcai("/api/activate", payload, "", upstreamProxy)
	if err != nil {
		l.setLastError(err.Error())
		return "", err
	}
	var resp CommonResp
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	if !resp.Success {
		message := resp.Message
		if message == "" {
			message = getApiErrorMessage(resp.Code)
		}
		l.setLastError(message)
		return "", errors.New(message)
	}
	var actData ActivateData
	if err := json.Unmarshal(resp.Data, &actData); err != nil {
		return "Activated (unknown expiry)", nil
	}
	l.setLastError("")
	return actData.AccountCard.ExpiresAt, nil
}

func (l *CodexLeaser) LeaseToken(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
	payload := map[string]interface{}{
		"reason":             "codex-local-proxy",
		"clientId":           deviceId,
		"clientVersion":      AppVersion,
		"clientDistribution": "go-engine",
	}
	for k, v := range options {
		payload[k] = v
	}

	body, _, err := postCodexBcai("/lease-token", payload, card, upstreamProxy)
	if err != nil {
		l.setLastError(err.Error())
		return nil, err
	}

	var leaseResp codexLeaseTokenResp
	if err := json.Unmarshal(body, &leaseResp); err != nil {
		return nil, err
	}
	if (leaseResp.Success != nil && !*leaseResp.Success) || (leaseResp.Ok != nil && !*leaseResp.Ok) {
		message := leaseResp.Message
		if message == "" {
			message = leaseResp.Error
		}
		if message == "" {
			message = getApiErrorMessage(leaseResp.Code)
		}
		l.setLastError(message)
		return nil, errors.New(message)
	}
	if leaseResp.AccessToken == "" {
		return nil, errors.New("empty Codex accessToken returned from server")
	}

	expiresAt := time.Now().Add(5 * time.Minute).UnixMilli()
	if leaseResp.ExpiresAt != "" {
		if parsed, err := time.Parse(time.RFC3339, leaseResp.ExpiresAt); err == nil {
			expiresAt = parsed.UnixMilli()
		}
	}
	lease := &CodexTokenLease{
		AccessToken: leaseResp.AccessToken,
		AccountId:   parseAccountId(leaseResp.AccountId),
		LeaseId:     leaseResp.LeaseId,
		EmailHint:   leaseResp.EmailHint,
		ExpiresAt:   expiresAt,
		LeasedAt:    time.Now().UnixMilli(),
	}
	l.setLastError("")
	return lease, nil
}

func (l *CodexLeaser) ReportUsage(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
	l.reportResult(card, details, upstreamProxy, lease)
}

func (l *CodexLeaser) ReportProblem(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
	l.reportResult(card, details, upstreamProxy, lease)
}

func (l *CodexLeaser) reportResult(card string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
	if lease == nil || lease.LeaseId == "" {
		return
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
		"cachedInputTokens": details.CachedInputTokens,
		"rawTotalTokens":    details.RawTotalTokens,
		"totalTokens":       details.BillableTotalTokens,
		"errorText":         getErrorSnippet(details.ErrorText),
	}
	// Attach the cached account-quota snapshot (one-shot) so the server can
	// quota-aware codex account selection — mirrors the antigravity flow.
	if snap := l.ConsumeCodexQuotaSnapshot(); snap != nil {
		payload["accountQuota"] = snap
	}
	go func() {
		l.doCodexReportWithRetry(payload, card, upstreamProxy)
		// 拉取本账号最新 5h/周限额。拿到后立即用同一个(仍新鲜的)lease 发一条 quota-only
		// report,让服务端即时更新后台额度 —— 否则 quota 会卡在缓存里,要等下一次生成
		// report 才上报,单发一条消息时后台永远显示 "—"。
		l.fetchCodexQuotaAsync(lease, upstreamProxy)
		if snap := l.peekCodexQuotaSnapshot(); snap != nil {
			l.reportQuotaOnly(card, upstreamProxy, lease, snap)
		}
	}()
}

// doCodexReportWithRetry 带退避重试上报;最终失败入队列,下次成功时补发(对齐 Gemini)。
func (l *CodexLeaser) doCodexReportWithRetry(payload map[string]interface{}, card, upstreamProxy string) {
	var err error
	for attempt := 1; attempt <= reportMaxRetries; attempt++ {
		if _, _, e := postCodexBcai("/report-result", payload, card, upstreamProxy); e == nil {
			err = nil
			break
		} else {
			err = e
		}
		if attempt < reportMaxRetries {
			time.Sleep(time.Duration(attempt*2) * time.Second) // 2s, 4s
		}
	}
	if err != nil {
		Log("[codex-leaser] ✗ 用量上报失败(已重试%d次,入队待补发): %v —— 这会导致服务端/web额度不刷新", reportMaxRetries, err)
		l.queueCodexReport(payload, card, upstreamProxy)
		return
	}
	Log("[codex-leaser] ✓ 用量上报成功(leaseId=%v tokens=%v)→ 服务端额度应已更新", payload["leaseId"], payload["totalTokens"])
	l.flushCodexPending(card, upstreamProxy)
}

func (l *CodexLeaser) queueCodexReport(payload map[string]interface{}, card, upstreamProxy string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.pendingReports) >= maxPendingReports {
		l.pendingReports = l.pendingReports[1:] // 队列满丢最旧
	}
	l.pendingReports = append(l.pendingReports, pendingReport{
		Payload: payload, Card: card, UpstreamProxy: upstreamProxy, AddedAt: time.Now(),
	})
	Log("[codex-leaser] queued failed report (%d pending)", len(l.pendingReports))
}

// flushCodexPending 在一次成功上报后补发积压队列;补发失败的重新入队。
func (l *CodexLeaser) flushCodexPending(card, upstreamProxy string) {
	l.mu.Lock()
	pending := l.pendingReports
	l.pendingReports = nil
	l.mu.Unlock()

	for _, r := range pending {
		if time.Since(r.AddedAt) > 30*time.Minute {
			continue // 过期丢弃
		}
		if _, _, err := postCodexBcai("/report-result", r.Payload, r.Card, r.UpstreamProxy); err != nil {
			l.queueCodexReport(r.Payload, r.Card, r.UpstreamProxy) // 仍失败,重新入队
		}
	}
}
