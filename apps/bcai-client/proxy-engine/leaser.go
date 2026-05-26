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

const API_BASE = "https://bcai.site/remote-token"

type TokenLease struct {
	AccessToken string `json:"accessToken"`
	ProjectId   string `json:"projectId"`
	AccountId   int    `json:"accountId"`
	LeaseId     string `json:"leaseId"`
	EmailHint   string `json:"emailHint"`
	ExpiresAt   int64  `json:"expiresAt"` // millisecond unix timestamp
	LeasedAt    int64  `json:"leasedAt"`
}

type Leaser struct {
	mu              sync.RWMutex
	cachedToken     *TokenLease
	lastError       string
	leaseCount      int
	reportCount     int
	cardExpires     string
	leaseRunning    bool
	cancelLease     context.CancelFunc
	accessKeyStatus map[string]interface{}
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
	Error                string          `json:"error"`   // remote-token-server uses "error" field
	AccessToken          string          `json:"accessToken"`
	ProjectId            string          `json:"projectId"`
	AccountId            json.RawMessage `json:"accountId"` // API may return number or string
	LeaseId              string          `json:"leaseId"`
	EmailHint            string          `json:"emailHint"`
	AccessTokenExpiresAt string          `json:"accessTokenExpiresAt"`
	AccessTokenExpiresIn int64           `json:"accessTokenExpiresIn"`
	ActivationExpiresAt  string          `json:"activationExpiresAt"`
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
	client := createHttpClient(upstreamProxy)

	payload := map[string]string{
		"accountCard": card,
		"deviceId":    deviceId,
	}

	Log("[token-leaser] Activating account card: %s...", card)
	body, _, err := postJson(client, "/api/activate", payload)
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

	client := createHttpClient(upstreamProxy)
	payload := map[string]interface{}{
		"reason":             "token-proxy-remote-mode",
		"clientId":           deviceId,
		"clientVersion":      "4.2.0",
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

	Log("[token-leaser] Requesting token lease...")
	body, _, err := postJsonWithSecret(client, "/lease-token", payload, card)
	if err != nil {
		l.mu.Lock()
		l.lastError = err.Error()
		l.mu.Unlock()
		Log("[token-leaser] Lease token network error: %v", err)
		return nil, err
	}

	// Parse lease response (same rules as proxy/token-leaser.js: success only when field is explicitly false)
	var leaseResp LeaseTokenResp
	if err := json.Unmarshal(body, &leaseResp); err != nil {
		return nil, fmt.Errorf("invalid lease json: %w", err)
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
	}

	l.mu.Lock()
	l.cachedToken = lease
	l.leaseCount++
	l.lastError = ""
	if leaseResp.ActivationExpiresAt != "" {
		l.cardExpires = leaseResp.ActivationExpiresAt
	}
	// Parse accessKeyStatus for quota display
	var rawResp map[string]interface{}
	if json.Unmarshal(body, &rawResp) == nil {
		if aks, ok := rawResp["accessKeyStatus"]; ok {
			if aksMap, ok := aks.(map[string]interface{}); ok {
				l.accessKeyStatus = aksMap
			}
		}
	}
	l.mu.Unlock()

	Log("[token-leaser] Token obtained! accountId=%d, project=%s, expires in %ds",
		lease.AccountId, lease.ProjectId, (expiresAt-time.Now().UnixNano()/int64(time.Millisecond))/1000)

	return lease, nil
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

func (l *Leaser) ReportProblemForAccount(card, deviceId string, reason string, upstreamProxy string, accountId int) {
	if accountId <= 0 {
		return
	}

	l.mu.Lock()
	l.reportCount++
	if l.cachedToken != nil && l.cachedToken.AccountId == accountId {
		l.cachedToken = nil // Clear cached token to force rotate on next lease
	}
	l.mu.Unlock()

	Log("[token-leaser] Reporting account %d unavailable, reason=%s", accountId, reason)
	client := createHttpClient(upstreamProxy)
	payload := map[string]interface{}{
		"accountId":   accountId,
		"reason":      reason,
		"statusCode":  0,
	}

	go func() {
		body, _, err := postJsonWithSecret(client, "/report-result", payload, card)
		if err != nil {
			Log("[token-leaser] Report-result network failed: %v", err)
			return
		}
		var r struct {
			Success bool `json:"success"`
		}
		if json.Unmarshal(body, &r) == nil && r.Success {
			Log("[token-leaser] Report accepted by server")
		}
	}()
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
		"accessKeyStatus":     l.accessKeyStatus,
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
