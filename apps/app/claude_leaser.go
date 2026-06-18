package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// 构建时通过 ldflags 注入 buildAPIBase；运行时可用 BCAI_ANTHROPIC_REMOTE_BASE 覆盖
var ANTHROPIC_REMOTE_BASE = getEnvOrDefault("BCAI_ANTHROPIC_REMOTE_BASE", buildAPIBase+"/api/app/lease/anthropic")

// ClaudeQuotaWindow 保存 claude 账号两个限额窗口的剩余百分比(0-100,越高越健康),
// 与服务端 claude.provider.applyQuotaSnapshot / leaseResponseExtras 的 claudeWindows 对齐。
type ClaudeQuotaWindow struct {
	HourlyPercent   float64 `json:"hourlyPercent"`
	WeeklyPercent   float64 `json:"weeklyPercent"`
	HourlyResetTime string  `json:"hourlyResetTime,omitempty"`
	WeeklyResetTime string  `json:"weeklyResetTime,omitempty"`
}

type ClaudeTokenLease struct {
	AccessToken string `json:"accessToken"`
	AccountId   int    `json:"accountId"`
	LeaseId     string `json:"leaseId"`
	EmailHint   string `json:"emailHint"`
	PlanType    string `json:"planType"` // 账号会员等级(max/pro/...),供前端展示
	ExpiresAt   int64  `json:"expiresAt"`
	LeasedAt    int64  `json:"leasedAt"`
	// EgressInfo 是服务端下发的出口策略(accountProxyUrl + egressRequired)。
	// anthropic 恒为 required:打 api.anthropic.com 那一跳必须经绑定代理,无代理则拒连。
	// 通过内嵌,lease.ProxyURL 仍可直接访问(= EgressInfo.ProxyURL),老调用点不变。
	EgressInfo
}

type claudeLeaseTokenResp struct {
	Success      *bool           `json:"success"`
	Ok           *bool           `json:"ok"`
	Code         string          `json:"code"`
	Message      string          `json:"message"`
	Error        string          `json:"error"`
	AccessToken  string          `json:"accessToken"`
	AccountId    json.RawMessage `json:"accountId"`
	LeaseId      string          `json:"leaseId"`
	EmailHint    string          `json:"emailHint"`
	PlanType     string          `json:"planType"`
	ExpiresAt    string          `json:"expiresAt"`
	BoundAccount *struct {
		Id       int     `json:"id"`
		Fraction float64 `json:"fraction"`
		ResetAt  int64   `json:"resetAt"`
	} `json:"boundAccount"`
	// 服务端把绑定/被租 claude 号的 5h+周窗口一并带回(来自共享号的最新已知用量),
	// 客户端据此渲染 claude 血条,无需自己抓上游(claude 不做客户端上游额度拉取)。
	ClaudeWindows *ClaudeQuotaWindow `json:"claudeWindows"`
	// 通用出口策略:该账号绑定的粘性出口代理 + 是否强制经代理出站。anthropic 恒 required。
	AccountProxyUrl string `json:"accountProxyUrl"`
	EgressRequired  bool   `json:"egressRequired"`
}

// ClaudeLeaser 镜像 CodexLeaser,但去掉了 codex 的客户端上游额度拉取机制
// (claude 的 5h/周窗口由服务端从 anthropic-ratelimit-* 头解析后随 lease 下发)。
type ClaudeLeaser struct {
	lastError string

	mu             sync.Mutex
	lastQuota      *ClaudeQuotaWindow // 持久副本(供前端显示 claude 血条)
	lastLease      *ClaudeTokenLease  // 最近一次成功租到的号(供前端"绑定账号信息"显示)
	pendingReports []pendingReport    // 失败上报队列(防丢用量)

	// nowFn 可注入时钟(测试用);为 nil 时回落到 time.Now。
	nowFn func() time.Time
}

// now 返回当前时间,允许测试注入。
func (l *ClaudeLeaser) now() time.Time {
	if l.nowFn != nil {
		return l.nowFn()
	}
	return time.Now()
}

var globalClaudeLeaser = &ClaudeLeaser{}

func GetClaudeLeaser() *ClaudeLeaser { return globalClaudeLeaser }

// LatestClaudeQuota 返回最近一次拿到的 claude 5h/周限额(供血条显示),无则 nil。
func (l *ClaudeLeaser) LatestClaudeQuota() *ClaudeQuotaWindow {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastQuota
}

// setLastError / LastError 用 l.mu 保护 lastError —— LeaseToken 每个入站代理
// 请求调用一次,可能跨 goroutine 并发(其余字段都已加锁,lastError 也必须加锁,
// 否则 `go test -race` 会报未同步读写)。
func (l *ClaudeLeaser) setLastError(msg string) {
	l.mu.Lock()
	l.lastError = msg
	l.mu.Unlock()
}

func (l *ClaudeLeaser) LastError() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastError
}

func (l *ClaudeLeaser) pendingCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.pendingReports)
}

func postClaudeBcai(path string, payload interface{}, secret string, upstreamProxy string) ([]byte, int, error) {
	respBody, status, err := postBcaiBaseWithFallback(ANTHROPIC_REMOTE_BASE, path, payload, secret, upstreamProxy)
	if err != nil {
		return respBody, status, err
	}
	if status >= 400 {
		return respBody, status, fmt.Errorf("remote claude status %d: %s", status, string(respBody))
	}
	return respBody, status, nil
}

func (l *ClaudeLeaser) LeaseToken(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*ClaudeTokenLease, error) {
	payload := map[string]interface{}{
		"reason":             "claude-local-proxy",
		"clientId":           deviceId,
		"clientVersion":      AppVersion,
		"clientDistribution": "go-engine",
	}
	for k, v := range options {
		payload[k] = v
	}

	body, status, err := postClaudeBcai("/lease-token", payload, card, upstreamProxy)
	if err != nil {
		recordAccountBuckets(body)
		recordFairShareQuota(body)
		// 不熔断、不重试:额度超限就如实返回,允许用户/IDE 自己再调(每次都真 lease,
		// accessKeyStatus 也随之刷新)。硬额度(token limit exceeded,retryAfter 达数小时)→
		// 返回结构化 QuotaExhaustedError,让 proxy 转成 429 + Retry-After 给 IDE,IDE 据此
		// 退避(而非把 502 当临时故障狂试)。临时限额/网络错误 → 原样返回。
		if status == 429 {
			if retryAfterMs, reason := parseQuota429(body); isHardQuotaLimit(retryAfterMs, reason) {
				qe := &QuotaExhaustedError{RetryAfterMs: retryAfterMs, Reason: reason}
				l.setLastError(qe.Error())
				Log("[claude-leaser] 🛑 硬额度超限:%s(约 %s 后恢复,不重试)", reason, humanizeMs(retryAfterMs))
				return nil, qe
			}
		}
		l.setLastError(err.Error())
		return nil, err
	}

	var leaseResp claudeLeaseTokenResp
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
		return nil, errors.New("empty Claude accessToken returned from server")
	}

	expiresAt := time.Now().Add(5 * time.Minute).UnixMilli()
	if leaseResp.ExpiresAt != "" {
		if parsed, err := time.Parse(time.RFC3339, leaseResp.ExpiresAt); err == nil {
			expiresAt = parsed.UnixMilli()
		}
	}
	lease := &ClaudeTokenLease{
		AccessToken: leaseResp.AccessToken,
		AccountId:   parseAccountId(leaseResp.AccountId),
		LeaseId:     leaseResp.LeaseId,
		EmailHint:   leaseResp.EmailHint,
		PlanType:    leaseResp.PlanType,
		ExpiresAt:   expiresAt,
		LeasedAt:    time.Now().UnixMilli(),
		EgressInfo:  EgressInfo{ProxyURL: leaseResp.AccountProxyUrl, EgressRequired: leaseResp.EgressRequired},
	}
	// 记录 claude 绑定号的真实上游剩余(供血条显示真实余量)。
	if leaseResp.BoundAccount != nil {
		mk, _ := options["modelKey"].(string)
		if mk == "" {
			mk = "claude-opus-4-20250514"
		}
		recordBoundFractionForModel("anthropic", mk, leaseResp.BoundAccount.Fraction, leaseResp.BoundAccount.ResetAt)
	}
	syncQuotaStateFromBody(GetLeaser(), body)
	l.applyClaudeWindows(leaseResp.ClaudeWindows)
	l.mu.Lock()
	l.lastLease = lease
	l.mu.Unlock()
	l.setLastError("")
	// 登记号池 token → 静态出口,供凭证感知出口决策识别「这是我们发的」(见 egress_credential.go)。
	registerPoolToken(lease.AccessToken, lease.ProxyURL)
	return lease, nil
}

// applyClaudeWindows 用服务端下发的 5h/周窗口更新本地持久快照(供血条显示)。
// nil 表示服务端暂无该号窗口数据 → 保留现有快照,不清空。
func (l *ClaudeLeaser) applyClaudeWindows(w *ClaudeQuotaWindow) {
	if w == nil {
		return
	}
	l.mu.Lock()
	cp := *w
	l.lastQuota = &cp
	l.mu.Unlock()
}

func (l *ClaudeLeaser) ReportUsage(card, deviceId string, details ReportDetails, upstreamProxy string, lease *ClaudeTokenLease) {
	l.reportResult(card, details, upstreamProxy, lease)
}

func (l *ClaudeLeaser) ReportProblem(card, deviceId string, details ReportDetails, upstreamProxy string, lease *ClaudeTokenLease) {
	l.reportResult(card, details, upstreamProxy, lease)
}

func (l *ClaudeLeaser) reportResult(card string, details ReportDetails, upstreamProxy string, lease *ClaudeTokenLease) {
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
	// 带上从上游响应头解析的 5h/周额度,服务端 applyQuotaSnapshot 落库 → 血条+刷新时间。
	// 字段名对齐服务端 claude.provider.applyQuotaSnapshot(quota.claudeQuota.*)。
	if details.HasClaudeWindows {
		payload["accountQuota"] = map[string]interface{}{
			"claudeQuota": map[string]interface{}{
				"hourlyPercent":   details.ClaudeHourlyPercent,
				"weeklyPercent":   details.ClaudeWeeklyPercent,
				"hourlyResetTime": details.ClaudeHourlyResetTime,
				"weeklyResetTime": details.ClaudeWeeklyResetTime,
			},
		}
	}
	go l.doClaudeReportWithRetry(payload, card, upstreamProxy)
}

// doClaudeReportWithRetry 带退避重试上报;最终失败入队列,下次成功时补发。
func (l *ClaudeLeaser) doClaudeReportWithRetry(payload map[string]interface{}, card, upstreamProxy string) {
	var err error
	var body []byte
	for attempt := 1; attempt <= reportMaxRetries; attempt++ {
		if b, _, e := postClaudeBcai("/report-result", payload, card, upstreamProxy); e == nil {
			body = b
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
		Log("[claude-leaser] ✗ 用量上报失败(已重试%d次,入队待补发): %v —— 这会导致服务端/web额度不刷新", reportMaxRetries, err)
		l.queueClaudeReport(payload, card, upstreamProxy)
		return
	}
	// 服务端 report-result 响应同样带回 fairShareQuota/weeklyFairShareQuota(与 lease 同形),
	// 立即刷新血条 —— 每次上报后即时更新,不必等下一次租号。
	recordAccountBuckets(body)
	recordFairShareQuota(body)
	billable := claudeDisplayBillable(payloadInt64(payload["rawTotalTokens"]), payloadInt64(payload["cachedInputTokens"]))
	Log("[claude-leaser] ✓ 用量上报成功(leaseId=%v 计费=%d 原始=%v)→ 服务端额度应已更新", payload["leaseId"], billable, payload["totalTokens"])
	l.flushClaudePending(card, upstreamProxy)
}

func (l *ClaudeLeaser) queueClaudeReport(payload map[string]interface{}, card, upstreamProxy string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.pendingReports) >= maxPendingReports {
		l.pendingReports = l.pendingReports[1:] // 队列满丢最旧
	}
	l.pendingReports = append(l.pendingReports, pendingReport{
		Payload: payload, Card: card, UpstreamProxy: upstreamProxy, AddedAt: time.Now(),
	})
	Log("[claude-leaser] queued failed report (%d pending)", len(l.pendingReports))
}

// flushClaudePending 在一次成功上报后补发积压队列;补发失败的重新入队。
func (l *ClaudeLeaser) flushClaudePending(card, upstreamProxy string) {
	l.mu.Lock()
	pending := l.pendingReports
	l.pendingReports = nil
	l.mu.Unlock()

	for _, r := range pending {
		if time.Since(r.AddedAt) > 30*time.Minute {
			continue // 过期丢弃
		}
		if _, _, err := postClaudeBcai("/report-result", r.Payload, r.Card, r.UpstreamProxy); err != nil {
			l.queueClaudeReport(r.Payload, r.Card, r.UpstreamProxy) // 仍失败,重新入队
		}
	}
}
