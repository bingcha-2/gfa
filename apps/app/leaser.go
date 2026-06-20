package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// API_BASE 可通过环境变量 BCAI_API_BASE 覆盖（本地开发用），构建时通过 ldflags 注入 buildAPIBase
var API_BASE = getEnvOrDefault("BCAI_API_BASE", buildAPIBase+"/api/app/lease/antigravity")

const defaultWindowMs int64 = 5 * 3600 * 1000 // 5h

type TokenLease struct {
	AccessToken    string                 `json:"accessToken"`
	ProjectId      string                 `json:"projectId"`
	AccountId      int                    `json:"accountId"`
	LeaseId        string                 `json:"leaseId"`
	EmailHint      string                 `json:"emailHint"`
	PlanType       string                 `json:"planType"`  // 账号会员等级(ultra/premium/...),供前端展示
	ExpiresAt      int64                  `json:"expiresAt"` // millisecond unix timestamp
	LeasedAt       int64                  `json:"leasedAt"`
	CandidateStats map[string]interface{} `json:"-"` // server-reported candidate stats
	Probation      bool                   `json:"-"`
	// Bound: 绑定卡(无其它号可换)。代理据此跳过"换到别的号"的轮转,
	// 但仍允许对同一个号做瞬时错误(503 容量/短 429)的等待重试。
	Bound bool `json:"-"`
	// EgressInfo 是服务端下发的出口策略。antigravity 为 optional:绑定代理则走它,
	// 没绑定就本地直连;绑定代理传输失败则降级本地直连再切号。
	EgressInfo
}

// LocalQuota 本地额度跟踪，镜像服务端的 5h 滑动窗口
type LocalQuota struct {
	WindowStartedAt  int64 // 窗口开始时间 (unix ms)
	WindowMs         int64 // 窗口长度 (ms)，从 accessKeyStatus.tokenWindowMs 获取
	OpusTokensUsed   int64
	OpusTokenLimit   int64
	GeminiTokensUsed int64
	GeminiTokenLimit int64
	CodexTokensUsed  int64
	CodexTokenLimit  int64
}

type pendingReport struct {
	Payload       map[string]interface{}
	Card          string
	UpstreamProxy string
	AddedAt       time.Time
}

const (
	reportMaxRetries    = 3
	maxPendingReports   = 30
	pendingReportMaxAge = 30 * time.Minute
)

type Leaser struct {
	mu                sync.RWMutex
	cachedToken       *TokenLease
	lastError         string
	leaseCount        int
	reportCount       int
	cardExpires       string
	leaseRunning      bool
	cancelLease       context.CancelFunc
	accessKeyStatus   map[string]interface{}
	accessKeyStatusAt time.Time // when accessKeyStatus was last received
	// P2⑨: Inflight lease dedup — prevents duplicate concurrent lease requests
	inflightMu     sync.Mutex
	inflightLease  map[string]chan struct{} // key → wait channel
	inflightResult map[string]*inflightLeaseResult
	// 本地计费
	localQuota LocalQuota
	quotaMode  string // "static" | "dynamic" | "unlimited"（服务端下发,见 syncFromServer)
	// 上报重试队列
	pendingReports []pendingReport
	// 远程租号的 quota 采集（quota_sync.go）
	cachedQuotaSnapshot *AccountQuotaSnapshot
	quotaFetching       int32  // atomic CAS flag，防并发
	lastQuotaFetchAt    int64  // 上次上游额度拉取时间(epoch ms)，用于频率节流
	lastModelKey        string // 上次 generation 使用的 modelKey，用于预热选号
	// 绑定号(本次租到的号)上游额度的下次刷新时间(epoch ms)。前端"额度恢复"倒计时
	// 优先用它 —— 反映的是绑定账号的真实 5h 上游重置,而非 GFA 本地窗口。
	boundResetAt int64
	// 卡密不可用(被服务端判为 Invalid/过期/禁用/未激活)。一旦置位,自动租号停止、
	// 功能禁用,只允许用户手动退出接管。重新激活有效卡(StartAutoLease)时复位。
	cardUnusable bool
	// 订阅授权(由心跳/接管启动喂入,见 leaser_entitlement.go)。冷启动「盲租 antigravity」的解药:
	// 启动前就知道订阅开了哪些产品 + 是否有生效订阅,据此决定 antigravity 是否常驻租号。
	entitledProducts  []string // 生效订阅的产品并集(antigravity/codex/anthropic)
	entitlementsKnown bool     // 是否已从心跳拿到授权(冷启动尚无 → false → 回退老 lease-products 逻辑)
	subActive         bool     // 是否有生效订阅
	// leaseFn 允许测试注入租号逻辑;nil 时走真实的 LeaseToken。仅供 StartAutoLease
	// 的自动租号循环使用,不影响代理/激活路径直接调用 LeaseToken。
	leaseFn func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error)
}

// autoLease 是 StartAutoLease 循环用的租号入口:默认调真实 LeaseToken,测试可注入 leaseFn。
func (l *Leaser) autoLease(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
	l.mu.RLock()
	fn := l.leaseFn
	l.mu.RUnlock()
	if fn != nil {
		return fn(card, deviceId, force, options, upstreamProxy)
	}
	return l.LeaseToken(card, deviceId, force, options, upstreamProxy)
}

// isCardFatalError 判断租号/激活错误是否代表"卡密本身不可用"(无可用卡密)。
// 致命:卡无效/缺失/过期/禁用/未激活 → 停掉自动租号、禁用功能。
// 非致命:繁忙、无号、网络错误、以及"未开通该服务"(卡有效只是没开这个池) → 继续重试。
func isCardFatalError(msg string) bool {
	m := strings.ToLower(msg)
	for _, s := range []string{
		// Legacy card-key fatal strings
		"invalid access key",
		"missing access key",
		"access key expired",
		"access key disabled",
		"account card not found",
		"account card expired",
		"account card inactive",
		"账号卡未激活",
		"账号卡已过期",
		"账号卡已禁用",
		// Account-login session fatal tokens
		"session_invalid",
		"subscription_expired",
		"device_revoked",
		"device_limit_exceeded",
	} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

type inflightLeaseResult struct {
	lease *TokenLease
	err   error
}

var globalLeaser = &Leaser{}

func GetLeaser() *Leaser {
	return globalLeaser
}

// ConnectViaProxy creates a TCP connection through an HTTP CONNECT proxy
func ConnectViaProxy(proxyUrlStr, targetHost string, targetPort int, timeout time.Duration) (net.Conn, error) {
	proxyUrl, err := url.Parse(proxyUrlStr)
	if err != nil {
		return nil, err
	}

	dialer := &net.Dialer{Timeout: timeout}
	proxyHost := proxyUrl.Host
	if !stringsContains(proxyHost, ":") {
		proxyHost = proxyHost + ":80"
	}

	conn, err := dialer.Dial("tcp", proxyHost)
	if err != nil {
		return nil, err
	}

	// Send CONNECT request
	connectReq := fmt.Sprintf("CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n", targetHost, targetPort, targetHost, targetPort)
	if proxyUrl.User != nil {
		pwd, _ := proxyUrl.User.Password()
		auth := fmt.Sprintf("%s:%s", proxyUrl.User.Username(), pwd)
		encodedAuth := base64Encode([]byte(auth))
		connectReq += fmt.Sprintf("Proxy-Authorization: Basic %s\r\n", encodedAuth)
	}
	connectReq += "Proxy-Connection: Keep-Alive\r\n\r\n"

	_, err = conn.Write([]byte(connectReq))
	if err != nil {
		conn.Close()
		return nil, err
	}

	// Read CONNECT response header
	br := make([]byte, 1024)
	n, err := conn.Read(br)
	if err != nil {
		conn.Close()
		return nil, err
	}

	respStr := string(br[:n])
	if !stringsContains(respStr, " 200 ") && !stringsContains(respStr, "200 OK") {
		conn.Close()
		return nil, fmt.Errorf("proxy CONNECT failed: %s", stringsSplit(respStr, "\r\n")[0])
	}

	return conn, nil
}

func base64Encode(data []byte) string {
	const encodeStd = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var buf bytes.Buffer
	limit := len(data)
	for i := 0; i < limit; i += 3 {
		remaining := limit - i
		var val uint32
		if remaining >= 3 {
			val = uint32(data[i])<<16 | uint32(data[i+1])<<8 | uint32(data[i+2])
			buf.WriteByte(encodeStd[val>>18&0x3F])
			buf.WriteByte(encodeStd[val>>12&0x3F])
			buf.WriteByte(encodeStd[val>>6&0x3F])
			buf.WriteByte(encodeStd[val&0x3F])
		} else if remaining == 2 {
			val = uint32(data[i])<<16 | uint32(data[i+1])<<8
			buf.WriteByte(encodeStd[val>>18&0x3F])
			buf.WriteByte(encodeStd[val>>12&0x3F])
			buf.WriteByte(encodeStd[val>>6&0x3F])
			buf.WriteByte('=')
		} else if remaining == 1 {
			val = uint32(data[i]) << 16
			buf.WriteByte(encodeStd[val>>18&0x3F])
			buf.WriteByte(encodeStd[val>>12&0x3F])
			buf.WriteByte('=')
			buf.WriteByte('=')
		}
	}
	return buf.String()
}

func stringsContains(s, substr string) bool {
	return len(s) >= len(substr) && indexOf(s, substr) >= 0
}

func indexOf(s, substr string) int {
	n := len(substr)
	if n == 0 {
		return 0
	}
	limit := len(s) - n
	for i := 0; i <= limit; i++ {
		if s[i:i+n] == substr {
			return i
		}
	}
	return -1
}

func stringsSplit(s, sep string) []string {
	var result []string
	if sep == "" {
		for i := 0; i < len(s); i++ {
			result = append(result, string(s[i]))
		}
		return result
	}
	start := 0
	for {
		idx := indexOf(s[start:], sep)
		if idx == -1 {
			result = append(result, s[start:])
			break
		}
		result = append(result, s[start:start+idx])
		start += idx + len(sep)
	}
	return result
}

// API structs
type LeaseTokenResp struct {
	Success              *bool           `json:"success"` // omitted on success; only present when false
	Ok                   *bool           `json:"ok"`      // remote-token-server uses "ok" field
	Code                 string          `json:"code"`
	Message              string          `json:"message"`
	Error                string          `json:"error"` // remote-token-server uses "error" field
	AccessToken          string          `json:"accessToken"`
	ProjectId            string          `json:"projectId"`
	AccountId            json.RawMessage `json:"accountId"` // API may return number or string
	LeaseId              string          `json:"leaseId"`
	EmailHint            string          `json:"emailHint"`
	PlanType             string          `json:"planType"`
	AccessTokenExpiresAt string          `json:"accessTokenExpiresAt"`
	AccessTokenExpiresIn int64           `json:"accessTokenExpiresIn"`
	ActivationExpiresAt  string          `json:"activationExpiresAt"`
	Probation            bool            `json:"probation"`
	BoundAccount         *struct {
		Id       int     `json:"id"`
		Fraction float64 `json:"fraction"`
		ResetAt  int64   `json:"resetAt"` // epoch ms,绑定号上游额度下次刷新
	} `json:"boundAccount"`
	// 通用出口策略:该账号绑定的粘性出口代理 + 是否强制经代理出站(antigravity 恒 false)。
	AccountProxyUrl string `json:"accountProxyUrl"`
	EgressRequired  bool   `json:"egressRequired"`
}

func parseAccountId(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	var n int
	if err := json.Unmarshal(raw, &n); err == nil {
		return n
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		n, _ = strconv.Atoi(strings.TrimSpace(s))
		return n
	}
	return 0
}

func (l *Leaser) LeaseToken(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
	if !GuardOK() {
		return nil, fmt.Errorf("service unavailable")
	}
	l.mu.Lock()
	if !force && l.cachedToken != nil {
		// Expire 60 seconds early
		nowMs := time.Now().UnixNano() / int64(time.Millisecond)
		if nowMs < (l.cachedToken.ExpiresAt - 60*1000) {
			token := *l.cachedToken
			l.mu.Unlock()
			return &token, nil
		}
	}
	l.mu.Unlock()

	payload := map[string]interface{}{
		"reason":             "token-proxy-remote-mode",
		"clientId":           deviceId,
		"clientVersion":      AppVersion,
		"clientDistribution": "go-engine",
		"isGeneration":       true,
	}

	l.mu.RLock()
	if l.cachedToken != nil && l.cachedToken.AccountId > 0 {
		payload["excludeAccountIds"] = []int{}
	}
	l.mu.RUnlock()

	if options != nil {
		for k, v := range options {
			payload[k] = v
		}
	}

	// 带重试的 lease-token 请求（解决租号服务偶发网络波动）
	const maxLeaseRetries = 3
	var body []byte
	var lastLeaseErr error
	for leaseAttempt := 1; leaseAttempt <= maxLeaseRetries; leaseAttempt++ {
		if leaseAttempt > 1 {
			// 稳态首次请求不打印,只在重试(异常)时记录
			Log("[token-leaser] Retrying token lease (%d/%d)...", leaseAttempt, maxLeaseRetries)
		}
		var err error
		body, _, err = postBcaiWithFallback("/lease-token", payload, card, upstreamProxy)
		if err == nil {
			lastLeaseErr = nil
			break
		}
		lastLeaseErr = err
		Log("[token-leaser] Lease token network error (attempt %d/%d): %v", leaseAttempt, maxLeaseRetries, err)

		// 如果还有缓存 token 且没被 force 刷新，直接返回缓存的
		if !force {
			l.mu.Lock()
			if l.cachedToken != nil {
				nowMs := time.Now().UnixNano() / int64(time.Millisecond)
				if nowMs < (l.cachedToken.ExpiresAt - 30*1000) { // 30s 容忍
					token := *l.cachedToken
					l.mu.Unlock()
					Log("[token-leaser] Network failed but using cached token (accountId=%d, expires in %ds)",
						token.AccountId, (token.ExpiresAt-nowMs)/1000)
					return &token, nil
				}
			}
			l.mu.Unlock()
		}

		if leaseAttempt < maxLeaseRetries {
			backoff := time.Duration(leaseAttempt) * time.Second // 1s, 2s, 3s
			time.Sleep(backoff)
		}
	}
	if lastLeaseErr != nil {
		l.mu.Lock()
		l.lastError = lastLeaseErr.Error()
		l.mu.Unlock()
		return nil, fmt.Errorf("租号服务暂时不可用 (重试%d次均失败): %w", maxLeaseRetries, lastLeaseErr)
	}

	// Parse lease response (same rules as proxy/token-leaser.js: success only when field is explicitly false)
	var leaseResp LeaseTokenResp
	if err := json.Unmarshal(body, &leaseResp); err != nil {
		// 空/截断 JSON 视为网络问题，尝试重新请求
		Log("[token-leaser] Invalid lease JSON (len=%d), retrying once: %v", len(body), err)
		body2, _, err2 := postBcaiWithFallback("/lease-token", payload, card, upstreamProxy)
		if err2 != nil {
			return nil, fmt.Errorf("invalid lease json + retry failed: %w", err2)
		}
		if err3 := json.Unmarshal(body2, &leaseResp); err3 != nil {
			return nil, fmt.Errorf("invalid lease json after retry (len=%d): %w", len(body2), err3)
		}
		body = body2
	}

	if (leaseResp.Success != nil && !*leaseResp.Success) || (leaseResp.Ok != nil && !*leaseResp.Ok) {
		errMsg := leaseResp.Message
		if errMsg == "" {
			errMsg = leaseResp.Error
		}
		if errMsg == "" {
			errMsg = getApiErrorMessage(leaseResp.Code)
		}
		// 「未开通该产品」的拒绝(订阅没开 antigravity,却被 IDE 轮询去租)不是账号异常:不污染
		// 全局 lastError,否则会错挂到 anthropic/codex 卡上弹假横幅。仍把错误返回给调用方(代理据此
		// 回落缓存/兜底)。covers=true 的真账号过期照常写,弹该产品的账号异常。
		surface := shouldSurfaceLeaseError(errMsg, l.coversAntigravity())
		l.mu.Lock()
		if surface {
			l.lastError = errMsg
		}
		l.mu.Unlock()
		Log("[token-leaser] Lease token failed: %s - %s", leaseResp.Code, errMsg)
		syncQuotaStateFromBody(l, body)
		// 硬额度(卡级 token 上限超限)→ 结构化 QuotaExhaustedError,让 proxy 转 429 + Retry-After。
		// antigravity 走 success=false,可能不带 retryAfterMs,靠文案识别;恢复时间未知则显示「稍后」。
		if rms, _ := parseQuota429(body); isHardQuotaLimit(rms, errMsg) {
			return nil, &QuotaExhaustedError{RetryAfterMs: rms, Reason: errMsg}
		}
		return nil, errors.New(errMsg)
	}

	if leaseResp.AccessToken == "" || leaseResp.ProjectId == "" {
		errMsg := "empty accessToken or projectId returned from server"
		if leaseResp.Code != "" {
			errMsg = getApiErrorMessage(leaseResp.Code)
		}
		l.mu.Lock()
		l.lastError = errMsg
		l.mu.Unlock()
		return nil, errors.New(errMsg)
	}

	accountId := parseAccountId(leaseResp.AccountId)

	// 记录绑定号上游额度的下次刷新时间(供"额度恢复"倒计时显示真实账号重置)。
	if leaseResp.BoundAccount != nil && leaseResp.BoundAccount.ResetAt > 0 {
		l.mu.Lock()
		l.boundResetAt = leaseResp.BoundAccount.ResetAt
		l.mu.Unlock()
	}
	// 记录绑定号在该模型上的真实上游剩余 + 恢复时间(供血条显示真实余量/倒计时)。
	if leaseResp.BoundAccount != nil {
		mk, _ := options["modelKey"].(string)
		recordBoundFractionForModel("antigravity", mk, leaseResp.BoundAccount.Fraction, leaseResp.BoundAccount.ResetAt)
	}
	// 服务端把"绑定号已知的各 bucket 额度"一并带回 → 激活/首次预热那一下就能把每条血条
	// 都填上真实值(共享号,别人用过就有数据),而非只填被租的那个模型。
	recordAccountBuckets(body)
	// 公平份额：如果服务端返回了 per-card fair share 比例，用它覆盖 accountBuckets。
	// fairShareQuota 反映的是"这张卡的均分额度剩余"而非"整个账号剩余"。
	recordFairShareQuota(body)

	// Calculate expiry time in millisecond unix timestamp
	var expiresAt int64
	if leaseResp.AccessTokenExpiresAt != "" {
		t, err := time.Parse(time.RFC3339, leaseResp.AccessTokenExpiresAt)
		if err == nil {
			expiresAt = t.UnixNano() / int64(time.Millisecond)
		} else {
			expiresAt = time.Now().Add(45*time.Minute).UnixNano() / int64(time.Millisecond)
		}
	} else if leaseResp.AccessTokenExpiresIn > 0 {
		expiresAt = (time.Now().UnixNano() / int64(time.Millisecond)) + (leaseResp.AccessTokenExpiresIn * 1000)
	} else {
		expiresAt = time.Now().Add(45*time.Minute).UnixNano() / int64(time.Millisecond)
	}

	lease := &TokenLease{
		AccessToken: leaseResp.AccessToken,
		ProjectId:   leaseResp.ProjectId,
		AccountId:   accountId,
		LeaseId:     leaseResp.LeaseId,
		EmailHint:   leaseResp.EmailHint,
		PlanType:    leaseResp.PlanType,
		ExpiresAt:   expiresAt,
		LeasedAt:    time.Now().UnixNano() / int64(time.Millisecond),
		Probation:   leaseResp.Probation,
		EgressInfo:  EgressInfo{ProxyURL: leaseResp.AccountProxyUrl, EgressRequired: leaseResp.EgressRequired},
	}

	// Parse extra fields from lease response (bound flag, candidate stats)
	var healthyForModel float64 // 候选池健康数,稳态下并入 "Token obtained" 一行
	var rawResp2 map[string]json.RawMessage
	if json.Unmarshal(body, &rawResp2) == nil {
		if bRaw, ok := rawResp2["bound"]; ok {
			var b bool
			if json.Unmarshal(bRaw, &b) == nil {
				lease.Bound = b
			}
		}
		if csRaw, ok := rawResp2["candidateStats"]; ok {
			var cs map[string]interface{}
			if json.Unmarshal(csRaw, &cs) == nil {
				lease.CandidateStats = cs
				getF := func(key string) float64 {
					if v, ok := cs[key]; ok {
						if f, ok := v.(float64); ok {
							return f
						}
					}
					return 0
				}
				healthyForModel = getF("healthyForModel")
				cooling, probation, excluded := getF("coolingForModel"), getF("probationForModel"), getF("excluded")
				// 仅在候选池出现异常(冷却/观察/排除)时单独打印,稳态合并进 "Token obtained"
				if cooling > 0 || probation > 0 || excluded > 0 {
					Log("[token-leaser] CandidateStats: healthyForModel=%.0f total=%.0f cooling=%.0f probation=%.0f excluded=%.0f",
						healthyForModel, getF("total"), cooling, probation, excluded)
				}
			}
		}
	}

	l.mu.Lock()
	l.cachedToken = lease
	l.leaseCount++
	l.lastError = ""
	l.cardUnusable = false
	if leaseResp.ActivationExpiresAt != "" {
		l.cardExpires = leaseResp.ActivationExpiresAt
	}
	l.mu.Unlock()

	// Parse accessKeyStatus for quota display + local quota calibration（syncFromServer 内部自带锁）
	var rawResp map[string]interface{}
	if json.Unmarshal(body, &rawResp) == nil {
		if aks, ok := rawResp["accessKeyStatus"]; ok {
			if aksMap, ok := aks.(map[string]interface{}); ok {
				l.syncFromServer(aksMap)
			}
		}
	}

	Log("[token-leaser] Token obtained! accountId=%d project=%s healthy=%.0f expires=%ds",
		lease.AccountId, lease.ProjectId, healthyForModel, (expiresAt-time.Now().UnixNano()/int64(time.Millisecond))/1000)

	return lease, nil
}

// LeaseTokenToLease is a convenience wrapper for Gemini API paths
func (l *Leaser) LeaseTokenToLease(card, deviceId string, upstream string) (*TokenLease, error) {
	return l.LeaseToken(card, deviceId, false, nil, upstream)
}

// coversAntigravity 当前订阅是否需要跑 antigravity 自动租号。优先用心跳喂入的订阅授权
// (entitledProducts),冷启动尚无授权时回退到「上次成功租号回写的 products」老逻辑
// (见 decideAntigravity)。只有 plan==agAttempt 才跑 antigravity。
func (l *Leaser) coversAntigravity() bool {
	l.mu.RLock()
	plan := decideAntigravity(l.entitlementsKnown, l.entitledProducts, l.subActive, productsFromAKS(l.accessKeyStatus))
	l.mu.RUnlock()
	return plan == agAttempt
}

func (l *Leaser) StartAutoLease(card, deviceId string, upstreamProxy string) {
	// 心跳已确知「无生效订阅」(取消/过期)→ 直接判卡密不可用,不发任何 antigravity 租号。
	// 这取代了过去「靠盲租一次 antigravity 被拒(SUBSCRIPTION_EXPIRED)才发现」的路径 ——
	// 后者会把「只开 codex/anthropic 的有效订阅」也误判成整卡不可用(本次修掉的 bug)。
	if l.entitlementsKnownNoSub() {
		l.markCardUnusable(fmt.Errorf("SUBSCRIPTION_EXPIRED"))
		return
	}

	// 整体逻辑:antigravity 自动租号只服务"开通了 antigravity 的订阅"(或冷启动尚未知时先试)。
	// 只开了 codex/anthropic 的订阅在此直接跳过 —— 不发无谓的 antigravity 租号请求,也不会把
	// "此订阅未开通该服务"当成错误刷屏/判死整卡。codex/anthropic 路径走自己的 leaser,不受影响。
	if !l.coversAntigravity() {
		l.mu.Lock()
		l.lastError = "" // 不是错误:本订阅没开通 antigravity → 前端不进入 error 状态
		l.leaseRunning = false
		l.cardUnusable = false // 有生效订阅(只是没开 antigravity)→ 卡可用;清掉冷启动盲租的误判
		l.mu.Unlock()
		Log("[token-leaser] 本卡未开通 Antigravity(products=%v),跳过 antigravity 常驻自动租号;codex/anthropic 激活时预热一次各自的额度", l.CardProducts())
		// 即便没有 antigravity 常驻租号,也要在激活时预热 codex/anthropic 的额度,
		// 否则它们的血条永远「未知」(预热原本只在 antigravity 路径里执行)。
		go l.preheatBoundProducts(card, deviceId, upstreamProxy, true)
		return
	}

	l.mu.Lock()
	if l.leaseRunning {
		if l.cancelLease != nil {
			l.cancelLease()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	l.cancelLease = cancel
	l.leaseRunning = true
	l.cardUnusable = false // 新一轮(可能换了有效卡)→ 复位不可用状态
	l.mu.Unlock()

	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		// Warmup lease immediately (use last known model for quota-aware selection)
		l.mu.RLock()
		warmupModel := l.lastModelKey
		l.mu.RUnlock()
		var warmupOpts map[string]interface{}
		if warmupModel != "" {
			warmupOpts = map[string]interface{}{"modelKey": warmupModel}
		}
		if _, err := l.autoLease(card, deviceId, false, warmupOpts, upstreamProxy); err != nil && isCardFatalError(err.Error()) {
			l.markCardUnusable(err)
			return
		}
		// 激活后立即刷新一次绑定号额度(血条上来就显示真实值,而非空白/100%)。
		// force=true:激活是用户主动操作,绕过 5min 节流,立刻拉 gemini/claude/codex。
		l.refreshBoundQuota(card, deviceId, upstreamProxy, true)

		// 额度刷新改为「按需」:不再定时轮询(消除闲置时的 5min 心跳 + codex usage 401 刷屏)。
		// 额度改为搭真实用量上报的车 —— antigravity 走 leaser_report.go(ConsumeQuotaSnapshot
		// 随 report attach + 上报后 fetchAccountQuotaAsync 节流缓存),codex 走 codex_leaser.go
		// reportResult 同理,claude 本就解析响应头。激活时上面已 force 刷一次。
		// 本 ticker 只保留 token 续租(临到期 60s 前续),不再碰额度。
		for {
			select {
			case <-ctx.Done():
				Log("[token-leaser] Auto-lease worker stopped")
				return
			case <-ticker.C:
				l.mu.RLock()
				needLease := false
				if l.cachedToken == nil {
					needLease = true
				} else {
					nowMs := time.Now().UnixNano() / int64(time.Millisecond)
					// Near expiry (60s early)
					if nowMs > (l.cachedToken.ExpiresAt - 60*1000) {
						needLease = true
					}
				}
				l.mu.RUnlock()

				if needLease {
					l.mu.RLock()
					renewalModel := l.lastModelKey
					l.mu.RUnlock()
					var renewOpts map[string]interface{}
					if renewalModel != "" {
						renewOpts = map[string]interface{}{"modelKey": renewalModel}
					}
					if _, err := l.autoLease(card, deviceId, false, renewOpts, upstreamProxy); err != nil && isCardFatalError(err.Error()) {
						l.markCardUnusable(err)
						return
					}
				}
			}
		}
	}()
}

// refreshBoundQuota 在绑定模式下重新租号,把血条刷新到绑定号的最新余量:
//   - antigravity:刷新 opus/gemini bucket + accessKeyStatus(返回模式/账号信息)
//   - codex(若该卡开通):刷新 5h/周窗口 + bucket(独立 leaser / 独立端点)
//

func getApiErrorMessage(code string) string {
	messages := map[string]string{
		"ACCOUNT_CARD_REQUIRED":            "请输入账号卡 (Please enter account card)",
		"ACCOUNT_CARD_NOT_FOUND":           "账号卡不存在，请检查卡号 (Account card not found, please check)",
		"ACCOUNT_CARD_INACTIVE":            "账号卡未激活 (Account card not activated)",
		"ACCOUNT_CARD_EXPIRED":             "账号卡已过期 (Account card expired)",
		"ACCOUNT_CARD_AND_DEVICE_REQUIRED": "缺少账号卡或设备ID (Missing account card or device ID)",
		"DEVICE_BOUND_TO_ANOTHER_CLIENT":   "该卡已在其他设备使用，请等10分钟重试 (Account in use on another device, wait 10 minutes)",
		"RATE_LIMITED":                     "请求过于频繁，请稍后重试 (Too many requests, please wait)",
		"UPSTREAM_TOKEN_LEASE_FAILED":      "上游服务暂时不可用，请稍后重试 (Upstream service unavailable, try later)",
	}
	if msg, ok := messages[code]; ok {
		return msg
	}
	return code
}
