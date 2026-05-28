package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// API_BASE 可通过环境变量 BCAI_API_BASE 覆盖（本地开发用）
var API_BASE = getEnvOrDefault("BCAI_API_BASE", "https://bcai.site/remote-token")

const defaultWindowMs int64 = 5 * 3600 * 1000 // 5h

type TokenLease struct {
	AccessToken    string                 `json:"accessToken"`
	ProjectId      string                 `json:"projectId"`
	AccountId      int                    `json:"accountId"`
	LeaseId        string                 `json:"leaseId"`
	EmailHint      string                 `json:"emailHint"`
	ExpiresAt      int64                  `json:"expiresAt"` // millisecond unix timestamp
	LeasedAt       int64                  `json:"leasedAt"`
	RetryPolicy    *RemoteRetryPolicy     `json:"-"` // P1④: server-controlled retry policy
	CandidateStats map[string]interface{} `json:"-"` // server-reported candidate stats
	Probation      bool                   `json:"-"`
}

// RemoteRetryPolicy mirrors the extension's normalizeRemoteRetryPolicy
// (token-proxy.js L66-96). Sent by the server in lease responses.
type RemoteRetryPolicy struct {
	MaxAttempts       int         `json:"maxAttempts"`
	RetryableStatuses []int       `json:"retryableStatuses"`
	StatusMaxAttempts map[int]int `json:"statusMaxAttempts"`
}

// LocalQuota 本地额度跟踪，镜像服务端的 5h 滑动窗口
type LocalQuota struct {
	WindowStartedAt  int64 // 窗口开始时间 (unix ms)
	WindowMs         int64 // 窗口长度 (ms)，从 accessKeyStatus.tokenWindowMs 获取
	OpusTokensUsed   int64
	OpusTokenLimit   int64
	GeminiTokensUsed int64
	GeminiTokenLimit int64
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
	// 上报重试队列
	pendingReports []pendingReport
	// 远程租号的 quota 采集（quota_sync.go）
	cachedQuotaSnapshot *AccountQuotaSnapshot
	quotaFetching       int32 // atomic CAS flag，防并发
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
type CommonResp struct {
	Success bool            `json:"success"`
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type ActivateData struct {
	AccountCard struct {
		ExpiresAt string `json:"expiresAt"`
	} `json:"accountCard"`
}

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
	AccessTokenExpiresAt string          `json:"accessTokenExpiresAt"`
	AccessTokenExpiresIn int64           `json:"accessTokenExpiresIn"`
	ActivationExpiresAt  string          `json:"activationExpiresAt"`
	Probation            bool            `json:"probation"`
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

func postJson(client *http.Client, path string, payload interface{}) ([]byte, int, error) {
	return postJsonWithSecret(client, path, payload, "")
}

func postJsonWithSecret(client *http.Client, path string, payload interface{}, secret string) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}

	urlStr := API_BASE + path
	req, err := http.NewRequest("POST", urlStr, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("x-token-server-secret", secret)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, err
}

func (l *Leaser) Activate(card, deviceId string, upstreamProxy string) (string, error) {
	payload := map[string]string{
		"accountCard": card,
		"deviceId":    deviceId,
	}

	Log("[token-leaser] Activating account card: %s...", card)
	body, _, err := postBcaiWithFallback("/api/activate", payload, "", upstreamProxy)
	if err != nil {
		l.mu.Lock()
		l.lastError = err.Error()
		l.mu.Unlock()
		Log("[token-leaser] Activate network error: %v", err)
		return "", err
	}

	var resp CommonResp
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("invalid response json: %w", err)
	}

	if !resp.Success {
		errMsg := getApiErrorMessage(resp.Code)
		l.mu.Lock()
		l.lastError = errMsg
		l.mu.Unlock()
		Log("[token-leaser] Activate failed: %s - %s", resp.Code, errMsg)
		return "", errors.New(errMsg)
	}

	var actData ActivateData
	if err := json.Unmarshal(resp.Data, &actData); err != nil {
		// Try parsing directly as success
		return "Activated (unknown expiry)", nil
	}

	l.mu.Lock()
	l.cardExpires = actData.AccountCard.ExpiresAt
	l.lastError = ""
	l.mu.Unlock()

	Log("[token-leaser] Activated OK, expires at: %s", actData.AccountCard.ExpiresAt)
	return actData.AccountCard.ExpiresAt, nil
}

func (l *Leaser) LeaseToken(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
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
		"clientVersion":      "5.0.6",
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

	// 带重试的 lease-token 请求（解决 bcai.site 偶发网络波动）
	const maxLeaseRetries = 3
	var body []byte
	var lastLeaseErr error
	for leaseAttempt := 1; leaseAttempt <= maxLeaseRetries; leaseAttempt++ {
		if leaseAttempt == 1 {
			Log("[token-leaser] Requesting token lease...")
		} else {
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
		l.mu.Lock()
		l.lastError = errMsg
		l.mu.Unlock()
		Log("[token-leaser] Lease token failed: %s - %s", leaseResp.Code, errMsg)
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
		ExpiresAt:   expiresAt,
		LeasedAt:    time.Now().UnixNano() / int64(time.Millisecond),
		Probation:   leaseResp.Probation,
	}

	// P1④: Parse retryPolicy from lease response (server-controlled retry)
	var rawResp2 map[string]json.RawMessage
	if json.Unmarshal(body, &rawResp2) == nil {
		if rpRaw, ok := rawResp2["retryPolicy"]; ok {
			var rp RemoteRetryPolicy
			if json.Unmarshal(rpRaw, &rp) == nil && rp.MaxAttempts > 0 {
				lease.RetryPolicy = &rp
				Log("[token-leaser] Server retryPolicy: maxAttempts=%d retryableStatuses=%v",
					rp.MaxAttempts, rp.RetryableStatuses)
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
				Log("[token-leaser] CandidateStats: healthyForModel=%.0f total=%.0f cooling=%.0f probation=%.0f excluded=%.0f",
					getF("healthyForModel"), getF("total"), getF("coolingForModel"), getF("probationForModel"), getF("excluded"))
			}
		}
	}

	l.mu.Lock()
	l.cachedToken = lease
	l.leaseCount++
	l.lastError = ""
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

	Log("[token-leaser] Token obtained! accountId=%d, project=%s, expires in %ds",
		lease.AccountId, lease.ProjectId, (expiresAt-time.Now().UnixNano()/int64(time.Millisecond))/1000)

	return lease, nil
}

// LeaseTokenToLease is a convenience wrapper for Gemini API paths
func (l *Leaser) LeaseTokenToLease(card, deviceId string, upstream string) (*TokenLease, error) {
	return l.LeaseToken(card, deviceId, false, nil, upstream)
}

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

	payload := map[string]interface{}{
		"leaseId":           lease.LeaseId,
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
	l.mu.Unlock()

	Log("[token-leaser] ReportUsage account=%d status=%d model=%s input=%d output=%d cached=%d billable=%d",
		lease.AccountId, details.StatusCode, details.ModelKey,
		details.InputTokens, details.OutputTokens, details.CachedInputTokens, details.BillableTotalTokens)

	payload := map[string]interface{}{
		"leaseId":           lease.LeaseId,
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

func (l *Leaser) StartAutoLease(card, deviceId string, upstreamProxy string) {
	l.mu.Lock()
	if l.leaseRunning {
		if l.cancelLease != nil {
			l.cancelLease()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	l.cancelLease = cancel
	l.leaseRunning = true
	l.mu.Unlock()

	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		// Warmup lease immediately
		_, _ = l.LeaseToken(card, deviceId, false, nil, upstreamProxy)

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
					_, _ = l.LeaseToken(card, deviceId, false, nil, upstreamProxy)
				}
			}
		}
	}()
}

func (l *Leaser) StopAutoLease() {
	l.mu.Lock()
	if l.cancelLease != nil {
		l.cancelLease()
		l.cancelLease = nil
	}
	l.leaseRunning = false
	l.cachedToken = nil
	l.mu.Unlock()
}

func (l *Leaser) ClearCache() {
	l.mu.Lock()
	l.cachedToken = nil
	l.mu.Unlock()
}

// ResetLocalQuota 换卡时清空本地额度跟踪
func (l *Leaser) ResetLocalQuota() {
	l.mu.Lock()
	l.localQuota = LocalQuota{}
	l.mu.Unlock()
	Log("[token-leaser] Local quota reset (card changed)")
}

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
		l.localQuota.WindowStartedAt = now
	}
	// 首次使用 → 初始化窗口
	if l.localQuota.WindowStartedAt == 0 {
		l.localQuota.WindowStartedAt = now
	}

	if isGeminiModel(modelKey) {
		l.localQuota.GeminiTokensUsed += billableTokens
	} else {
		l.localQuota.OpusTokensUsed += billableTokens
	}
}

// CheckLocalQuota 在 lease 之前调用，检查本地额度是否充足
// 返回 (ok, waitMs, reason)
func (l *Leaser) CheckLocalQuota(modelKey string) (bool, int64, string) {
	l.mu.RLock()
	defer l.mu.RUnlock()

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
				"Gemini 额度已用尽 (%d/%d tokens)，%d分钟后恢复",
				q.GeminiTokensUsed, q.GeminiTokenLimit, resetMs/60000)
		}
	} else {
		if q.OpusTokenLimit > 0 && q.OpusTokensUsed >= q.OpusTokenLimit {
			return false, resetMs, fmt.Sprintf(
				"Opus 额度已用尽 (%d/%d tokens)，%d分钟后恢复",
				q.OpusTokensUsed, q.OpusTokenLimit, resetMs/60000)
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

	// 限额以服务端为准
	if v, ok := aks["opusTokenLimit"].(float64); ok && v > 0 {
		l.localQuota.OpusTokenLimit = int64(v)
	}
	if v, ok := aks["geminiTokenLimit"].(float64); ok && v > 0 {
		l.localQuota.GeminiTokenLimit = int64(v)
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
	// 反推窗口起始时间
	if v, ok := aks["tokenWindowResetMs"].(float64); ok && v > 0 {
		wMs := l.localQuota.WindowMs
		if wMs <= 0 {
			wMs = defaultWindowMs
		}
		l.localQuota.WindowStartedAt = time.Now().UnixMilli() + int64(v) - wMs
	}
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
		"accessKeyStatus":     aks,
		"localQuota": map[string]interface{}{
			"opusTokensUsed":   l.localQuota.OpusTokensUsed,
			"opusTokenLimit":   l.localQuota.OpusTokenLimit,
			"geminiTokensUsed": l.localQuota.GeminiTokensUsed,
			"geminiTokenLimit": l.localQuota.GeminiTokenLimit,
			"windowResetMs":    localResetMs,
			"pendingReports":   len(l.pendingReports),
		},
	}
}

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
