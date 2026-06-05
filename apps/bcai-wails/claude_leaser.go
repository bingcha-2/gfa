package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// 默认走主域名 bcai.lol，请求失败自动回退到备域名 bcai.site（见 bcai_hosts.go）
var ANTHROPIC_REMOTE_BASE = getEnvOrDefault("BCAI_ANTHROPIC_REMOTE_BASE", "https://bcai.lol/remote-anthropic")

// 429「公平限额已用完」熔断参数：拿到 429 即按卡开闸，冷却期内本地直接快速失败，
// 不再逐条把请求打到租号上游（避免 #98→#112 那种一秒几十条 429 的重试风暴）。
// 冷却时长随连续命中指数翻倍：base, 2·base, 4·base … 封顶 max。
var (
	claudeBreakerBase = getEnvDurationOrDefault("BCAI_CLAUDE_BREAKER_BASE", 15*time.Second)
	claudeBreakerMax  = getEnvDurationOrDefault("BCAI_CLAUDE_BREAKER_MAX", 5*time.Minute)
)

// leaseBreaker 记录单张卡的 429 熔断状态。
type leaseBreaker struct {
	until  time.Time // 冷却截止；此刻之前 LeaseToken 直接快速失败
	streak int       // 连续 429 次数，用于指数退避
}

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
	// ProxyURL 是服务端为该账号下发的粘性出口代理(住宅/移动 IP),空=直连。
	// 客户端用它路由打 api.anthropic.com 的那一跳,实现"每号固定出口 IP"。
	ProxyURL string `json:"proxyUrl"`
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
	// 该账号的粘性出口代理(住宅 IP),供客户端固定该号出口。空=直连。
	ClaudeProxyUrl string `json:"claudeProxyUrl"`
}

// ClaudeLeaser 镜像 CodexLeaser,但去掉了 codex 的客户端上游额度拉取机制
// (claude 的 5h/周窗口由服务端从 anthropic-ratelimit-* 头解析后随 lease 下发)。
type ClaudeLeaser struct {
	lastError string

	mu             sync.Mutex
	lastQuota      *ClaudeQuotaWindow       // 持久副本(供前端显示 claude 血条)
	lastLease      *ClaudeTokenLease        // 最近一次成功租到的号(供前端"绑定账号信息"显示)
	pendingReports []pendingReport          // 失败上报队列(防丢用量)
	breakers       map[string]*leaseBreaker // 429 熔断状态,按卡(card)独立——一张卡限额爆了不连累别的卡

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

// breakerRetryAfter 若该卡正处于 429 熔断冷却中,返回(剩余时长, true);否则(0, false)。
func (l *ClaudeLeaser) breakerRetryAfter(card string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.breakers[card]
	if b == nil {
		return 0, false
	}
	now := l.now()
	if !now.Before(b.until) {
		return 0, false
	}
	return b.until.Sub(now), true
}

// breakerTrip 在该卡命中 429 时开闸/续期,按连续次数指数退避,返回本次冷却时长。
func (l *ClaudeLeaser) breakerTrip(card string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.breakers == nil {
		l.breakers = make(map[string]*leaseBreaker)
	}
	b := l.breakers[card]
	if b == nil {
		b = &leaseBreaker{}
		l.breakers[card] = b
	}
	b.streak++
	cool := claudeBreakerBase << (b.streak - 1) // base, 2·base, 4·base …
	if cool <= 0 || cool > claudeBreakerMax {   // 溢出或超封顶 → 取 max
		cool = claudeBreakerMax
	}
	b.until = l.now().Add(cool)
	return cool
}

// breakerReset 在该卡成功租到号后清除熔断状态。
func (l *ClaudeLeaser) breakerReset(card string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.breakers, card)
}

var globalClaudeLeaser = &ClaudeLeaser{}

func GetClaudeLeaser() *ClaudeLeaser { return globalClaudeLeaser }

// LatestClaudeQuota 返回最近一次拿到的 claude 5h/周限额(供血条显示),无则 nil。
func (l *ClaudeLeaser) LatestClaudeQuota() *ClaudeQuotaWindow {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastQuota
}

// setLastError / LastError 用 l.mu 保护 lastError —— LeaseToken/Activate 每个入站代理
// 请求各调用一次,可能跨 goroutine 并发(其余字段都已加锁,lastError 也必须加锁,
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

func (l *ClaudeLeaser) Activate(card, deviceId string, upstreamProxy string) (string, error) {
	payload := map[string]string{"accountCard": card, "deviceId": deviceId}
	body, _, err := postClaudeBcai("/api/activate", payload, "", upstreamProxy)
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

	// 熔断:该卡仍在 429 冷却期内 → 本地直接快速失败,不再打租号上游。
	if wait, open := l.breakerRetryAfter(card); open {
		err := fmt.Errorf("公平限额已用完,熔断冷却中(约 %ds 后自动重试)", int(wait.Seconds()+0.5))
		l.setLastError(err.Error())
		return nil, err
	}

	body, status, err := postClaudeBcai("/lease-token", payload, card, upstreamProxy)
	if err != nil {
		if status == 429 { // 公平限额已用完 → 开闸冷却,后续请求本地快速失败
			cool := l.breakerTrip(card)
			Log("[claude-leaser] ⛔ 公平限额 429,熔断该卡 %ds 内不再请求上游(避免重试风暴)", int(cool.Seconds()+0.5))
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
		ProxyURL:    leaseResp.ClaudeProxyUrl,
	}
	// 记录 claude 绑定号的真实上游剩余(供血条显示真实余量)。
	if leaseResp.BoundAccount != nil {
		mk, _ := options["modelKey"].(string)
		if mk == "" {
			mk = "claude-opus-4-20250514"
		}
		recordBoundFractionForModel("anthropic", mk, leaseResp.BoundAccount.Fraction, leaseResp.BoundAccount.ResetAt)
	}
	recordAccountBuckets(body)
	// 多卡拼车:服务端按份额下发 fairShareQuota，覆盖账号级 bucket，让每张卡看到自己份额的血条。
	recordFairShareQuota(body)
	l.applyClaudeWindows(leaseResp.ClaudeWindows)
	l.mu.Lock()
	l.lastLease = lease
	l.mu.Unlock()
	l.breakerReset(card) // 成功租到号 → 清除该卡熔断状态
	l.setLastError("")
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
	for attempt := 1; attempt <= reportMaxRetries; attempt++ {
		if _, _, e := postClaudeBcai("/report-result", payload, card, upstreamProxy); e == nil {
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
	Log("[claude-leaser] ✓ 用量上报成功(leaseId=%v tokens=%v)→ 服务端额度应已更新", payload["leaseId"], payload["totalTokens"])
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
