package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const DefaultCloudEndpoint = "https://cloudcode-pa.googleapis.com"
const DefaultGeminiEndpoint = "https://generativelanguage.googleapis.com"
const MaxCloudCodeGenerationAttempts = 10

type ProxyStats struct {
	TotalRequests              int64   `json:"totalRequests"`
	TotalErrors                int64   `json:"totalErrors"`
	TotalRetries               int64   `json:"totalRetries"`
	TotalInputTokens           int64   `json:"totalInputTokens"`
	TotalOutputTokens          int64   `json:"totalOutputTokens"`
	TotalCachedTokens          int64   `json:"totalCachedTokens"`
	TotalSuccessfulGenerations int64   `json:"totalSuccessfulGenerations"`
	SavedMoneyUSD              float64 `json:"savedMoneyUSD"`
	// 按模型分类的 token 统计
	OpusInputTokens    int64 `json:"opusInputTokens"`
	OpusOutputTokens   int64 `json:"opusOutputTokens"`
	GeminiInputTokens  int64 `json:"geminiInputTokens"`
	GeminiOutputTokens int64 `json:"geminiOutputTokens"`
}

// ProxyServer 核心代理业务逻辑
type ProxyServer struct {
	mu           sync.Mutex
	stats        ProxyStats
	upstreamCool int64 // timestamp until upstream is considered cool

	// 当前请求的模型 key（用于 streaming 时传递给 token 统计）
	lastModelKey string

	// fetchAvailableModels 缓存（timo 的 x-timo-cache 行为）
	modelsCacheMu   sync.RWMutex
	modelsCache     []byte
	modelsCacheTime int64 // unix timestamp
}

var globalProxy = &ProxyServer{}

// debugResponseBody 将响应体转换为可读的日志字符串
// 自动解压 gzip，截断到 maxLen 字符，过滤不可打印字符
func debugResponseBody(data []byte, contentEncoding string, maxLen int) string {
	readable := data
	// 尝试 gzip 解压
	if strings.Contains(strings.ToLower(contentEncoding), "gzip") || (len(data) > 2 && data[0] == 0x1f && data[1] == 0x8b) {
		r, err := gzip.NewReader(bytes.NewReader(data))
		if err == nil {
			decompressed, err := io.ReadAll(r)
			_ = r.Close()
			if err == nil {
				readable = decompressed
			}
		}
	}
	s := string(readable)
	if len(s) > maxLen {
		s = s[:maxLen] + "..."
	}
	return s
}

func GetProxy() *ProxyServer {
	return globalProxy
}

func (p *ProxyServer) GetStats() ProxyStats {
	stats := ProxyStats{
		TotalRequests:              atomic.LoadInt64(&p.stats.TotalRequests),
		TotalErrors:                atomic.LoadInt64(&p.stats.TotalErrors),
		TotalRetries:               atomic.LoadInt64(&p.stats.TotalRetries),
		TotalInputTokens:           atomic.LoadInt64(&p.stats.TotalInputTokens),
		TotalOutputTokens:          atomic.LoadInt64(&p.stats.TotalOutputTokens),
		TotalCachedTokens:          atomic.LoadInt64(&p.stats.TotalCachedTokens),
		TotalSuccessfulGenerations: atomic.LoadInt64(&p.stats.TotalSuccessfulGenerations),
		OpusInputTokens:            atomic.LoadInt64(&p.stats.OpusInputTokens),
		OpusOutputTokens:           atomic.LoadInt64(&p.stats.OpusOutputTokens),
		GeminiInputTokens:          atomic.LoadInt64(&p.stats.GeminiInputTokens),
		GeminiOutputTokens:         atomic.LoadInt64(&p.stats.GeminiOutputTokens),
	}

	// Calculate savings: $5 / 1M input, $25 / 1M output
	inputVal := float64(stats.TotalInputTokens) / 1000000.0 * 5.0
	outputVal := float64(stats.TotalOutputTokens) / 1000000.0 * 25.0
	stats.SavedMoneyUSD = inputVal + outputVal

	return stats
}

// classifyModel 将模型名分类为 opus / gemini / other
func classifyModel(modelKey string) string {
	if modelKey == "" {
		return "other"
	}
	lower := strings.ToLower(modelKey)
	if strings.Contains(lower, "opus") || strings.Contains(lower, "claude") {
		return "opus"
	}
	if strings.Contains(lower, "gemini") || strings.Contains(lower, "pro") || strings.Contains(lower, "flash") {
		return "gemini"
	}
	return "other"
}

func isGenerationRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ":streamgeneratecontent") ||
		strings.Contains(lower, ":generatecontent") ||
		strings.Contains(lower, "streamgeneratecontent") ||
		strings.Contains(lower, "generatecontent") ||
		strings.Contains(lower, "bidigeneratecontent")
}

func isCloudCodeRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "/v1internal") ||
		strings.Contains(lower, "v1internal:")
}

func upstreamEndpointForPath(path string) string {
	if isCloudCodeRequest(path) {
		return DefaultCloudEndpoint
	}
	return DefaultGeminiEndpoint
}

func isModelsRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ":fetchavailablemodels") || strings.Contains(lower, "fetchavailablemodels")
}

func isUndefinedEndpoint(path string) bool {
	lower := strings.ToLower(path)
	return lower == "/v1internal/undefined" || strings.HasSuffix(lower, "/undefined")
}

func isNoiseRequest(path string) bool {
	lower := strings.ToLower(path)
	// IDE 启动/保活类接口，直接返回 mock（不转发）
	// 注意：getUserInfo/onboardUser 等认证接口必须透传，不能 mock
	return strings.Contains(lower, "listexperiments") ||
		strings.Contains(lower, "cascadenuxes") ||
		strings.Contains(lower, "loadcodeassist") ||
		strings.Contains(lower, "fetchavailablemodels") ||
		strings.Contains(lower, "counttokens") ||
		strings.Contains(lower, "fetchadmincontrols") ||
		strings.Contains(lower, "recordcodeassistmetrics") ||
		strings.Contains(lower, "/client/metrics")
}

// isPassthroughRequest 认证相关请求：保留 IDE 原始 OAuth token 直接透传给 Google
// timo 也采用相同策略 — 不替换 token，不 mock
func isPassthroughRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "getuserinfo") ||
		strings.Contains(lower, "onboarduser") ||
		strings.Contains(lower, "fetchuserinfo")
}

func ideFallbackPayload(path string) (interface{}, bool) {
	lower := strings.ToLower(path)
	if isModelsRequest(path) {
		return buildFallbackModels(), true
	}
	if strings.Contains(lower, "cascadenuxes") ||
		strings.Contains(lower, ":listexperiments") ||
		strings.Contains(lower, "listexperiments") ||
		strings.Contains(lower, ":counttokens") ||
		strings.Contains(lower, ":loadcodeassist") ||
		strings.Contains(lower, "loadcodeassist") ||
		strings.Contains(lower, "fetchadmincontrols") ||
		strings.Contains(lower, "recordcodeassistmetrics") ||
		strings.Contains(lower, "/client/metrics") {
		return map[string]interface{}{}, true
	}
	return nil, false
}

// ServeHTTP 处理单条 HTTP 请求
func (p *ProxyServer) ServeHTTP(w http.ResponseWriter, r *http.Request, card, deviceId string, bypass bool, upstream string) {
	atomic.AddInt64(&p.stats.TotalRequests, 1)
	GetUsageStats().AddRequest()
	reqId := atomic.LoadInt64(&p.stats.TotalRequests)

	isNoise := isNoiseRequest(r.URL.Path)
	if !isNoise {
		Log("[proxy] #%d <- %s %s", reqId, r.Method, r.URL.Path)
	}

	// Read body
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		if !isNoise {
			Log("[proxy] #%d Failed to read body: %v", reqId, err)
		}
		p.sendJsonError(w, 400, "Failed to read request body")
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

	isGen := isGenerationRequest(r.URL.Path)

	// If bypass mode is enabled, forward directly with original headers
	if bypass {
		if !isNoise {
			Log("[proxy] #%d [BYPASS] forwarding directly to Google", reqId)
		}
		p.forwardToGoogle(w, r, bodyBytes, upstream, reqId)
		return
	}

	if isGen {
		if isCloudCodeRequest(r.URL.Path) {
			p.handleGenerationRequest(w, r, bodyBytes, card, deviceId, upstream, reqId)
		} else {
			p.handleGeminiGenerationRequest(w, r, bodyBytes, card, deviceId, upstream, reqId)
		}
	} else {
		p.handleNonGenerationRequest(w, r, bodyBytes, card, deviceId, upstream, reqId)
	}
}

func (p *ProxyServer) handleNonGenerationRequest(w http.ResponseWriter, r *http.Request, body []byte, card, deviceId string, upstream string, reqId int64) {
	if isUndefinedEndpoint(r.URL.Path) {
		Log("[proxy] #%d [MOCK] undefined endpoint safety net", reqId)
		p.sendJson(w, 200, map[string]interface{}{})
		return
	}

	// 噪音/初始化请求（loadCodeAssist, cascadeNuxes, listExperiments 等）
	// 直接返回 mock 响应，不转发到 Google（与 timo 行为一致）
	if isNoiseRequest(r.URL.Path) && !isModelsRequest(r.URL.Path) {
		if fallback, ok := ideFallbackPayload(r.URL.Path); ok {
			p.sendJson(w, 200, fallback)
			return
		}
	}

	// fetchAvailableModels 特殊处理：带缓存 + token 注入
	if isModelsRequest(r.URL.Path) {
		p.handleFetchModelsWithCache(w, r, body, card, deviceId, upstream, reqId)
		return
	}

	// 认证相关请求（getUserInfo 等）：保留 IDE 原始 OAuth token 透传
	// 不替换为租用 token，否则 IDE 重启后会认为未登录（与 timo 行为一致）
	if isPassthroughRequest(r.URL.Path) {
		Log("[proxy] #%d [PASSTHROUGH] %s (keeping original auth)", reqId, r.URL.Path)
		p.forwardToGoogle(w, r, body, upstream, reqId)
		return
	}

	// 其他非生成请求注入 token 后转发
	p.forwardWithInjectedToken(w, r, body, card, deviceId, upstream, reqId)
}

// handleFetchModelsWithCache 带缓存 + token 注入的 fetchAvailableModels 处理
func (p *ProxyServer) handleFetchModelsWithCache(w http.ResponseWriter, r *http.Request, body []byte, card, deviceId string, upstream string, reqId int64) {
	endpoint := upstreamEndpointForPath(r.URL.Path)
	targetUrl, _ := url.Parse(endpoint + r.URL.Path + "?" + r.URL.RawQuery)
	req, err := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(body))
	if err != nil {
		p.serveModelsCache(w, reqId, "request build error")
		return
	}

	for k, v := range r.Header {
		lower := strings.ToLower(k)
		if lower == "host" || lower == "authorization" {
			continue
		}
		for _, val := range v {
			req.Header.Add(k, val)
		}
	}
	req.Header.Set("Host", targetUrl.Host)

	// 注入我们的 token
	if card != "" {
		leaser := GetLeaser()
		lease, err := leaser.LeaseToken(card, deviceId, false, nil, upstream)
		if err != nil {
			Log("[proxy] #%d [MODELS] token lease failed: %v, trying cache", reqId, err)
			p.serveModelsCache(w, reqId, "token lease error")
			return
		}
		req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
		Log("[proxy] #%d [MODELS] -> fetchAvailableModels (injected token)", reqId)
	} else {
		Log("[proxy] #%d [MODELS] -> fetchAvailableModels (no card, using cache)", reqId)
		p.serveModelsCache(w, reqId, "no card configured")
		return
	}

	client := createHttpClient(upstream)
	resp, err := client.Do(req)
	if err != nil {
		Log("[proxy] #%d [MODELS] upstream error: %v", reqId, err)
		p.serveModelsCache(w, reqId, "network error")
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 200 {
		// 成功 → 缓存响应
		p.modelsCacheMu.Lock()
		p.modelsCache = make([]byte, len(respBody))
		copy(p.modelsCache, respBody)
		p.modelsCacheTime = time.Now().Unix()
		p.modelsCacheMu.Unlock()
		Log("[proxy] #%d [MODELS] <- 200 OK, cached (%d bytes)", reqId, len(respBody))

		for k, v := range resp.Header {
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(200)
		_, _ = w.Write(respBody)
	} else {
		Log("[proxy] #%d [MODELS] <- %d, serving cache", reqId, resp.StatusCode)
		p.serveModelsCache(w, reqId, fmt.Sprintf("upstream %d", resp.StatusCode))
	}
}

func (p *ProxyServer) serveModelsCache(w http.ResponseWriter, reqId int64, reason string) {
	p.modelsCacheMu.RLock()
	cached := p.modelsCache
	cacheTime := p.modelsCacheTime
	p.modelsCacheMu.RUnlock()

	if cached != nil && len(cached) > 0 {
		age := time.Now().Unix() - cacheTime
		Log("[proxy] #%d [MODELS-CACHE] serving cached models (age: %ds, reason: %s)", reqId, age, reason)
		w.Header().Set("Content-Type", "application/json; charset=UTF-8")
		w.Header().Set("X-BingchaAI-Cache", "HIT")
		w.WriteHeader(200)
		_, _ = w.Write(cached)
	} else {
		Log("[proxy] #%d [MODELS-CACHE] no cache, serving fallback (reason: %s)", reqId, reason)
		fallback := buildFallbackModels()
		p.sendJson(w, 200, fallback)
	}
}

// forwardWithInjectedToken 为非生成请求注入 token 后转发（loadCodeAssist 等）
func (p *ProxyServer) forwardWithInjectedToken(w http.ResponseWriter, r *http.Request, body []byte, card, deviceId string, upstream string, reqId int64) {
	endpoint := upstreamEndpointForPath(r.URL.Path)
	targetUrl, _ := url.Parse(endpoint + r.URL.Path + "?" + r.URL.RawQuery)
	req, err := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(body))
	if err != nil {
		p.sendJsonError(w, 500, "Internal request error")
		return
	}

	origAuth := r.Header.Get("Authorization")
	for k, v := range r.Header {
		lower := strings.ToLower(k)
		if lower == "host" || lower == "content-length" {
			continue
		}
		// 如果原请求有 auth 且我们能注入 token，先跳过 auth header
		if lower == "authorization" && origAuth != "" && card != "" {
			continue
		}
		for _, val := range v {
			req.Header.Add(k, val)
		}
	}
	req.Header.Set("Host", targetUrl.Host)
	if len(body) > 0 {
		req.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	}

	// 只在原请求携带 Authorization 时才替换 token
	if origAuth != "" && card != "" {
		leaser := GetLeaser()
		lease, err := leaser.LeaseToken(card, deviceId, false, nil, upstream)
		if err != nil {
			Log("[proxy] #%d token lease failed, forwarding with original auth: %v", reqId, err)
			req.Header.Set("Authorization", origAuth)
		} else {
			req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
		}
	}

	isNoise := isNoiseRequest(r.URL.Path)

	client := createHttpClient(upstream)

	// 带重试（解决启动时连接池冷启动 EOF）
	const maxRetries = 5
	var resp *http.Response
	var doErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		// 每次重试需要重建 request（body reader 被消费）
		retryReq, _ := http.NewRequest(req.Method, req.URL.String(), bytes.NewReader(body))
		retryReq.Header = req.Header.Clone()
		if len(body) > 0 {
			retryReq.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
		}

		resp, doErr = client.Do(retryReq)
		if doErr == nil {
			break
		}
		if attempt < maxRetries {
			backoff := time.Duration(attempt) * time.Second
			Log("[proxy] #%d Forward attempt %d/%d failed: %v, retrying in %v...", reqId, attempt, maxRetries, doErr, backoff)
			time.Sleep(backoff)
		}
	}

	if doErr != nil {
		Log("[proxy] #%d Forward failed after %d attempts: %v", reqId, maxRetries, doErr)
		if fallback, ok := ideFallbackPayload(r.URL.Path); ok {
			p.sendJson(w, 200, fallback)
			return
		}
		p.sendJsonError(w, 502, fmt.Sprintf("Upstream unavailable: %v", doErr))
		return
	}
	defer resp.Body.Close()

	if !isNoise {
		respBody, _ := io.ReadAll(resp.Body)
		Log("[proxy] #%d [DEBUG] <- Status: %d, Body(%d bytes): %s", reqId, resp.StatusCode, len(respBody), debugResponseBody(respBody, resp.Header.Get("Content-Encoding"), 500))
		for k, v := range resp.Header {
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBody)
	} else {
		for k, v := range resp.Header {
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}



func (p *ProxyServer) handleGenerationRequest(w http.ResponseWriter, r *http.Request, body []byte, card, deviceId string, upstream string, reqId int64) {
	cfg := LoadConfig()
	isLocalPool := cfg.PoolMode == "local"

	// 1. Validate: either card (remote) or pool accounts (local) required
	if !isLocalPool && card == "" {
		Log("[proxy] #%d [BLOCK] Generation failed: no account card configured", reqId)
		p.sendJsonError(w, 503, "BingchaAI: Please configure and activate your account card first.")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	if isLocalPool && GetAccountPool().EnabledCount() == 0 {
		Log("[proxy] #%d [BLOCK] Generation failed: no accounts in local pool", reqId)
		p.sendJsonError(w, 503, "BingchaAI: 本地号池中没有可用账号，请先添加账号。")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}

	// 2. Fail-closed check: JSON body must contain project or projectId field
	var parsedBody interface{}
	if err := json.Unmarshal(body, &parsedBody); err != nil {
		Log("[proxy] #%d [BLOCK] Invalid JSON request body", reqId)
		p.sendJsonError(w, 400, "Invalid JSON body")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}

	hasProject := hasProjectField(parsedBody)
	if !hasProject {
		Log("[proxy] #%d [INFO] No project/projectId in body, will inject from lease", reqId)
	}

	// P0: Extract model key from request body (e.g. "gemini-2.5-pro")
	requestModelKey := extractModelKeyFromBody(body)
	if requestModelKey != "" {
		Log("[proxy] #%d [MODEL] %s", reqId, requestModelKey)
	}

	targetUrl, _ := url.Parse(DefaultCloudEndpoint + r.URL.Path + "?" + r.URL.RawQuery)
	Log("[proxy] #%d [UPSTREAM] generation host=%s path=%s (mode=%s)", reqId, targetUrl.Host, targetUrl.Path, cfg.PoolMode)
	// 生成请求使用无全局超时的 streaming client，避免 120s 截断长响应
	client := createStreamingHttpClient(upstream)

	var resp *http.Response
	var lease *TokenLease
	attemptSessionId := fmt.Sprintf("%d-%d", time.Now().UnixMilli(), reqId)

	if isLocalPool {
		// ====== LOCAL POOL MODE ======
		var excludeIds []int
		for attempt := 1; attempt <= MaxCloudCodeGenerationAttempts; attempt++ {
			pool := GetAccountPool()
			acc, selErr := pool.SelectAccount(requestModelKey, excludeIds)
			if selErr != nil {
				Log("[proxy] #%d [LOCAL-POOL] No available account: %v", reqId, selErr)
				p.sendJsonError(w, 503, fmt.Sprintf("本地号池: %v", selErr))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}

			token, tokenErr := pool.GetAccessToken(acc.ID)
			if tokenErr != nil {
				Log("[proxy] #%d [LOCAL-POOL] Token refresh failed for #%d (%s): %v", reqId, acc.ID, acc.Email, tokenErr)
				excludeIds = append(excludeIds, acc.ID)
				pool.MarkError(acc.ID)
				pool.RecordRequestStats(acc.ID, false)
				if attempt < MaxCloudCodeGenerationAttempts {
					continue
				}
				p.sendJsonError(w, 503, fmt.Sprintf("本地号池: token 刷新失败: %v", tokenErr))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}

			// Build lease-like object for consistent downstream handling
			lease = &TokenLease{
				AccessToken: token,
				ProjectId:   acc.ProjectId,
				AccountId:   acc.ID,
				EmailHint:   acc.Email,
			}
			Log("[proxy] #%d [LOCAL-POOL] attempt=%d account=#%d (%s) project=%s", reqId, attempt, acc.ID, acc.Email, acc.ProjectId)
			pool.SetActiveAccount(acc.ID)

			rewrittenBody, _ := rewriteProjectFields(parsedBody, lease.ProjectId)
			if !hasProject {
				if bodyMap, ok := rewrittenBody.(map[string]interface{}); ok {
					bodyMap["project"] = lease.ProjectId
					rewrittenBody = bodyMap
				}
			}
			if bodyMap, ok := rewrittenBody.(map[string]interface{}); ok {
				credits, _ := bodyMap["enabledCreditTypes"].([]interface{})
				hasGoogleOneAI := false
				for _, c := range credits {
					if s, ok := c.(string); ok && s == "GOOGLE_ONE_AI" {
						hasGoogleOneAI = true
						break
					}
				}
				if !hasGoogleOneAI {
					bodyMap["enabledCreditTypes"] = append(credits, "GOOGLE_ONE_AI")
					rewrittenBody = bodyMap
				}
			}
			newBodyBytes, _ := json.Marshal(rewrittenBody)

			req, _ := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(newBodyBytes))
			for k, v := range r.Header {
				lower := strings.ToLower(k)
				if lower == "authorization" || lower == "host" || lower == "content-length" || lower == "x-goog-api-key" || lower == "x-goog-user-project" {
					continue
				}
				for _, val := range v {
					req.Header.Add(k, val)
				}
			}
			req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
			req.Header.Set("Host", targetUrl.Host)
			req.Header.Set("Content-Length", fmt.Sprintf("%d", len(newBodyBytes)))

			var doErr error
			resp, doErr = client.Do(req)
			if doErr != nil {
				Log("[proxy] #%d [LOCAL-POOL] upstream error: %v", reqId, doErr)
				p.sendJsonError(w, 502, fmt.Sprintf("Upstream error: %v", doErr))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}

			problemReason := ""
			if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusInternalServerError || resp.StatusCode == http.StatusBadRequest {
				respBytes := readAndResetResponseBody(resp)
				problemReason = cloudCodeAccountProblemReason(resp.StatusCode, string(respBytes))
			}
			if problemReason == "" {
				pool.MarkSuccess(acc.ID)
				pool.RecordRequestStats(acc.ID, true)
				pool.PostRequestHealthRefresh(acc.ID)
				break
			}

			Log("[proxy] #%d [LOCAL-POOL] account #%d returned %d (%s), rotating...", reqId, acc.ID, resp.StatusCode, problemReason)
			// Use retryAfterMs if available, otherwise default 30 min
			localRetryMs := extractQuotaResetDelayMs(string(readAndResetResponseBody(resp)))
			cooldownMin := 30
			if localRetryMs > 0 {
				cooldownMin = int(localRetryMs / 60000)
				if cooldownMin < 1 {
					cooldownMin = 1
				}
			}
			pool.MarkExhausted(acc.ID, problemReason, requestModelKey, cooldownMin)
			pool.RecordRequestStats(acc.ID, false)
			excludeIds = append(excludeIds, acc.ID)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			atomic.AddInt64(&p.stats.TotalRetries, 1)
			GetUsageStats().AddRetry()

			if attempt >= MaxCloudCodeGenerationAttempts {
				break
			}
		}
	} else {
		// ====== REMOTE LEASE MODE (original) ======
		leaser := GetLeaser()
		// 本地额度检查
		if ok, waitMs, reason := leaser.CheckLocalQuota(requestModelKey); !ok {
			Log("[proxy] #%d [QUOTA-LOCAL] %s", reqId, reason)
			w.Header().Set("Retry-After", fmt.Sprintf("%d", waitMs/1000))
			p.sendJsonError(w, 429, fmt.Sprintf("BingchaAI: %s", reason))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
	// P1④: Dynamic max attempts — start with default, update from server retryPolicy
	remoteMaxAttempts := MaxCloudCodeGenerationAttempts
	accumulatedCapacityWaitMs := int64(0)
	const maxCapacityWaitMs = int64(60000) // P2⑩: Max 60s total capacity wait
	// 记录本次请求中已失败的 accountId，防止 report-result 还没到服务端时又租到同一个号
	var excludeAccountIds []int
	for attempt := 1; attempt <= remoteMaxAttempts; attempt++ {
		var err error
		leaseOptions := map[string]interface{}{
			"attemptSessionId": attemptSessionId,
			"modelKey":         requestModelKey,
		}
		if len(excludeAccountIds) > 0 {
			leaseOptions["excludeAccountIds"] = excludeAccountIds
		}
		lease, err = leaser.LeaseToken(card, deviceId, attempt > 1, leaseOptions, upstream)
		if err != nil {
			Log("[proxy] #%d [TOKEN-ERROR] Failed to lease token: %v", reqId, err)
			p.sendJsonError(w, 503, fmt.Sprintf("租号服务暂时不可用，请稍后重试: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
		// P1④: Update maxAttempts from server retryPolicy
		if lease.RetryPolicy != nil && lease.RetryPolicy.MaxAttempts > 0 {
			remoteMaxAttempts = lease.RetryPolicy.MaxAttempts
			if remoteMaxAttempts > 99 {
				remoteMaxAttempts = 99
			}
		}
		Log("[proxy] #%d [LEASE] attempt=%d/%d accountId=%d project=%s model=%s", reqId, attempt, remoteMaxAttempts, lease.AccountId, lease.ProjectId, requestModelKey)

		rewrittenBody, _ := rewriteProjectFields(parsedBody, lease.ProjectId)
		// 生成请求必须有 project 字段，没有则注入
		if !hasProject {
			if bodyMap, ok := rewrittenBody.(map[string]interface{}); ok {
				bodyMap["project"] = lease.ProjectId
				rewrittenBody = bodyMap
			}
		}
		// 注入 enabledCreditTypes: GOOGLE_ONE_AI（默认消耗积分，与 token-proxy.js 行为一致）
		if bodyMap, ok := rewrittenBody.(map[string]interface{}); ok {
			credits, _ := bodyMap["enabledCreditTypes"].([]interface{})
			hasGoogleOneAI := false
			for _, c := range credits {
				if s, ok := c.(string); ok && s == "GOOGLE_ONE_AI" {
					hasGoogleOneAI = true
					break
				}
			}
			if !hasGoogleOneAI {
				bodyMap["enabledCreditTypes"] = append(credits, "GOOGLE_ONE_AI")
				rewrittenBody = bodyMap
			}
		}
		newBodyBytes, err := json.Marshal(rewrittenBody)
		if err != nil {
			Log("[proxy] #%d [REWRITE-ERROR] Failed to marshal rewritten body: %v", reqId, err)
			p.sendJsonError(w, 500, "Internal rewrite error")
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		req, err := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(newBodyBytes))
		if err != nil {
			Log("[proxy] #%d [REQ-ERROR] Failed to build proxy request: %v", reqId, err)
			p.sendJsonError(w, 500, "Internal request creation error")
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		// Copy headers and inject the leased bearer token
		for k, v := range r.Header {
			lower := strings.ToLower(k)
			if lower == "authorization" ||
				lower == "host" ||
				lower == "content-length" ||
				lower == "x-goog-api-key" ||
				lower == "x-goog-user-project" {
				continue
			}
			for _, val := range v {
				req.Header.Add(k, val)
			}
		}
		req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
		req.Header.Set("Host", targetUrl.Host)
		req.Header.Set("Content-Length", fmt.Sprintf("%d", len(newBodyBytes)))

		resp, err = client.Do(req)
		if err != nil {
			Log("[proxy] #%d [FORWARD-ERROR] Upstream request failed: %v", reqId, err)
			p.sendJsonError(w, 502, fmt.Sprintf("Upstream gateway error: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		problemReason := ""
		errorBody := ""
		if resp.StatusCode == http.StatusTooManyRequests ||
			resp.StatusCode == http.StatusForbidden ||
			resp.StatusCode == http.StatusServiceUnavailable ||
			resp.StatusCode == http.StatusInternalServerError ||
			resp.StatusCode == http.StatusBadRequest {
			respBytes := readAndResetResponseBody(resp)
			errorBody = string(respBytes)
			problemReason = cloudCodeAccountProblemReason(resp.StatusCode, errorBody)
		}
		if problemReason == "" {
			break
		}

		// P0: Parse retryAfterMs from 429 error body
		retryAfterMs := extractQuotaResetDelayMs(errorBody)
		// P0: Extract model from error response (503 capacity errors contain model name)
		errorModelKey := extractCapacityModelKey(errorBody)
		if errorModelKey == "" {
			errorModelKey = requestModelKey
		}

		// P0: Build enriched report details
		reportDetails := ReportDetails{
			StatusCode:   resp.StatusCode,
			ModelKey:     errorModelKey,
			Reason:       problemReason,
			RetryAfterMs: retryAfterMs,
			ErrorText:    errorBody,
		}

		// P2⑪: Verification challenge → report + rotate to another account
		// (mirrors token-proxy.js L1812-L1822: shouldRetryRemoteError → continue)
		if resp.StatusCode == http.StatusForbidden && isVerificationChallengeError(errorBody) {
			Log("[proxy] #%d [VERIFY] Verification challenge for accountId=%d, rotating (%d/%d)",
				reqId, lease.AccountId, attempt, remoteMaxAttempts)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			excludeAccountIds = append(excludeAccountIds, lease.AccountId)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			if attempt < remoteMaxAttempts {
				atomic.AddInt64(&p.stats.TotalRetries, 1)
				GetUsageStats().AddRetry()
				time.Sleep(remoteRetryDelayForStatus(attempt, http.StatusForbidden))
				continue
			}
			// All attempts exhausted — return friendly 503
			Log("[proxy] #%d [VERIFY] Verification challenge exhausted after %d attempts", reqId, attempt)
			p.sendJsonError(w, 503, "Remote account temporarily unavailable (verification required). Please retry.")
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		// P1④: Check if this status is retryable per server retryPolicy
		// #5: Use statusMaxAttempts to expand retry limit for specific status codes
		effectiveMaxAttempts := remoteMaxAttempts
		if lease.RetryPolicy != nil && lease.RetryPolicy.StatusMaxAttempts != nil {
			if statusLimit, ok := lease.RetryPolicy.StatusMaxAttempts[resp.StatusCode]; ok && statusLimit > effectiveMaxAttempts {
				effectiveMaxAttempts = statusLimit
				if effectiveMaxAttempts > 99 {
					effectiveMaxAttempts = 99
				}
			}
		}
		canRetry := attempt < effectiveMaxAttempts
		if lease.RetryPolicy != nil && len(lease.RetryPolicy.RetryableStatuses) > 0 {
			statusRetryable := false
			for _, s := range lease.RetryPolicy.RetryableStatuses {
				if s == resp.StatusCode {
					statusRetryable = true
					break
				}
			}
			if !statusRetryable {
				canRetry = false
			}
		}

		// #3: Short rate-limit (<5s RATE_LIMIT_EXCEEDED) — wait and retry SAME account
		// (mirrors token-proxy.js L1744-L1752)
		if resp.StatusCode == http.StatusTooManyRequests &&
			retryAfterMs > 0 && retryAfterMs < 5000 &&
			strings.Contains(errorBody, "RATE_LIMIT_EXCEEDED") &&
			attempt < effectiveMaxAttempts+2 {
			waitMs := retryAfterMs + 500
			Log("[proxy] #%d [SHORT-RATELIMIT] 429 RATE_LIMIT_EXCEEDED retryAfter=%dms, waiting %dms and retrying same account=%d",
				reqId, retryAfterMs, waitMs, lease.AccountId)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			time.Sleep(time.Duration(waitMs) * time.Millisecond)
			// Don't add to excludeAccountIds — retry same account
			continue
		}

		// P2⑩: 503 capacity wait — wait and retry instead of immediate rotate
		if resp.StatusCode == http.StatusServiceUnavailable &&
			strings.Contains(strings.ToLower(errorBody), "capacity") &&
			accumulatedCapacityWaitMs < maxCapacityWaitMs {
			waitMs := int64(5000) // default 5s
			if retryAfterMs > 0 && retryAfterMs < 30000 {
				waitMs = retryAfterMs
			}
			accumulatedCapacityWaitMs += waitMs
			Log("[proxy] #%d [CAPACITY-WAIT] 503 capacity, waiting %dms (total=%dms/%dms) for model=%s",
				reqId, waitMs, accumulatedCapacityWaitMs, maxCapacityWaitMs, errorModelKey)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			time.Sleep(time.Duration(waitMs) * time.Millisecond)
			continue
		}

		if canRetry {
			respStatus := resp.StatusCode
			Log("[proxy] #%d Upstream returned %d (%s) model=%s retryAfter=%dms for accountId=%d; rotating (%d/%d)",
				reqId, respStatus, problemReason, errorModelKey, retryAfterMs, lease.AccountId, attempt, remoteMaxAttempts)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			// 将失败的 accountId 加入排除列表，防止异步 report 还没到时又租到同一个号
			excludeAccountIds = append(excludeAccountIds, lease.AccountId)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			atomic.AddInt64(&p.stats.TotalRetries, 1)
			GetUsageStats().AddRetry()
			// P1: Exponential backoff between retries
			time.Sleep(remoteRetryDelayForStatus(attempt, respStatus))
			continue
		}

		Log("[proxy] #%d Upstream returned %d (%s) after %d attempts for accountId=%d, reporting...",
			reqId, resp.StatusCode, problemReason, attempt, lease.AccountId)
		leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
		break
	}
	} // end remote lease mode
	if resp == nil {
		p.sendJsonError(w, 502, "Upstream gateway error: no response after retries")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	defer resp.Body.Close()

	// [P3 TIMO-STYLE] 首 chunk 缓冲：在 WriteHeader 之前先读第一个 chunk
	// 如果第一个 chunk 就是 quota/capacity 错误（Google 返回 200 但 body 是错误），
	// 此时还没有向 IDE 发送任何数据，可以换号重试
	isStreaming := strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") ||
		strings.Contains(r.URL.Path, "streamGenerateContent")
	var firstChunk []byte
	if isStreaming {
		buf := make([]byte, 8192) // 读大一点以覆盖完整的错误 JSON
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			firstChunk = make([]byte, n)
			copy(firstChunk, buf[:n])
			if reason, mk, retryMs := checkStreamingQuotaError(string(firstChunk)); reason != "" {
				// 首 chunk 就是错误！关闭连接，上报，不向 IDE 发送任何数据
				Log("[proxy] #%d [FIRST-CHUNK-ERROR] %s in first chunk model=%s retryAfter=%dms, will NOT commit response",
					reqId, reason, mk, retryMs)
				_ = resp.Body.Close()
				// 上报错误
				if isLocalPool && lease != nil {
					pool := GetAccountPool()
					cooldownMin := 30
					if retryMs > 0 {
						cooldownMin = int(retryMs / 60000)
						if cooldownMin < 1 { cooldownMin = 1 }
					}
					pool.MarkExhausted(lease.AccountId, reason, mk, cooldownMin)
				} else if lease != nil {
					statusCode := 429
					if reason == "capacity" { statusCode = 503 }
					GetLeaser().ReportProblemWithDetails(card, deviceId, ReportDetails{
						StatusCode: statusCode, ModelKey: mk, Reason: reason, RetryAfterMs: retryMs,
					}, upstream, lease)
				}
				// 返回结构化错误给 IDE（此时还能设置正确的 status code）
				p.sendJsonError(w, 429, fmt.Sprintf("Account quota exhausted (%s), please retry", reason))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
		}
		if readErr != nil && readErr != io.EOF {
			Log("[proxy] #%d [FIRST-CHUNK] read error: %v", reqId, readErr)
		}
	}

	// 首 chunk 正常 → 提交 HTTP 响应头（此后不可逆）
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(resp.StatusCode)

	// 设置当前模型 key（streaming 时使用）
	p.mu.Lock()
	p.lastModelKey = requestModelKey
	p.mu.Unlock()

	var tokenResult TokenUsageResult
	if isStreaming {
		// 先写出已缓冲的首 chunk
		if len(firstChunk) > 0 {
			_, _ = w.Write(firstChunk)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		// Streaming response: parse remaining chunks on the fly
		tokenResult = p.streamResponse(w, resp.Body, reqId)
		// 将首 chunk 的 bytes 也计入 token 解析
		if len(firstChunk) > 0 {
			tokenResult.StreamBytes += int64(len(firstChunk))
		}
	} else {
		// Single response: read all and parse
		respBytes, err := io.ReadAll(resp.Body)
		if err == nil {
			_, _ = w.Write(respBytes)
			tokenResult = p.parseAndAddTokenUsage(respBytes, resp.Header.Get("Content-Encoding"), requestModelKey)
		}
	}

	// [TIMO-STYLE] 流式中途 quota 错误：上报 + 标记账号
	if tokenResult.StreamError {
		Log("[proxy] #%d [STREAM-QUOTA-REPORT] reporting mid-stream %s for model=%s",
			reqId, tokenResult.StreamErrorReason, tokenResult.StreamErrorModel)
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
		if isLocalPool && lease != nil {
			pool := GetAccountPool()
			cooldownMin := 30
			if tokenResult.StreamRetryAfterMs > 0 {
				cooldownMin = int(tokenResult.StreamRetryAfterMs / 60000)
				if cooldownMin < 1 { cooldownMin = 1 }
			}
			pool.MarkExhausted(lease.AccountId, tokenResult.StreamErrorReason, tokenResult.StreamErrorModel, cooldownMin)
		} else if lease != nil {
			leaser := GetLeaser()
			statusCode := 429
			if tokenResult.StreamErrorReason == "capacity" { statusCode = 503 }
			leaser.ReportProblemWithDetails(card, deviceId, ReportDetails{
				StatusCode:   statusCode,
				ModelKey:     tokenResult.StreamErrorModel,
				Reason:       tokenResult.StreamErrorReason,
				RetryAfterMs: tokenResult.StreamRetryAfterMs,
			}, upstream, lease)
		}
		return
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		atomic.AddInt64(&p.stats.TotalSuccessfulGenerations, 1)
		GetUsageStats().AddGeneration()
		// 上报成功请求的 token 用量到服务器，不释放 lease（保持账号粘性）
		if lease != nil && !isLocalPool {
			leaser := GetLeaser()
			// 本地记账
			if tokenResult.BillableTotalTokens > 0 {
				leaser.RecordLocalUsage(requestModelKey, int64(tokenResult.BillableTotalTokens))
			}
			leaser.ReportUsage(card, deviceId, ReportDetails{
				StatusCode:        resp.StatusCode,
				ModelKey:          requestModelKey,
				InputTokens:       tokenResult.InputTokens,
				OutputTokens:      tokenResult.OutputTokens,
				CachedInputTokens: tokenResult.CachedInputTokens,
				RawTotalTokens:    tokenResult.RawTotalTokens,
				BillableTotalTokens: tokenResult.BillableTotalTokens,
			}, upstream, lease)
			// 影子校验通道
			if tokenResult.RawTotalTokens > 0 {
				go leaser.syncMetrics(card, lease,
					tokenResult.InputTokens, tokenResult.OutputTokens,
					tokenResult.CachedInputTokens, tokenResult.RawTotalTokens,
					tokenResult.StreamBytes, requestModelKey, upstream)
			}
		}
	} else {
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
	}
}

func (p *ProxyServer) handleGeminiGenerationRequest(w http.ResponseWriter, r *http.Request, body []byte, card, deviceId string, upstream string, reqId int64) {
	cfg := LoadConfig()
	isLocalPool := cfg.PoolMode == "local"

	// 提取模型 key（Gemini API 路径包含模型名）
	requestModelKey := extractModelKeyFromPath(r.URL.Path)
	if requestModelKey == "" {
		requestModelKey = extractModelKeyFromBody(body)
	}

	if !isLocalPool && card == "" {
		Log("[proxy] #%d [BLOCK] Gemini generation failed: no account card configured", reqId)
		p.sendJsonError(w, 503, "BingchaAI: Please configure and activate your account card first.")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	if isLocalPool && GetAccountPool().EnabledCount() == 0 {
		Log("[proxy] #%d [BLOCK] Gemini generation failed: no accounts in local pool", reqId)
		p.sendJsonError(w, 503, "BingchaAI: 本地号池中没有可用账号，请先添加账号。")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}

	targetUrl, _ := url.Parse(DefaultGeminiEndpoint + r.URL.Path + "?" + r.URL.RawQuery)
	query := targetUrl.Query()
	if _, ok := query["key"]; ok {
		query.Del("key")
		targetUrl.RawQuery = query.Encode()
	}
	Log("[proxy] #%d [UPSTREAM] Gemini generation host=%s path=%s (mode=%s)", reqId, targetUrl.Host, targetUrl.Path, cfg.PoolMode)
	client := createStreamingHttpClient(upstream)
	attemptSessionId := fmt.Sprintf("%d-%d", time.Now().UnixMilli(), reqId)

	var resp *http.Response
	var lease *TokenLease

	if isLocalPool {
		// ====== LOCAL POOL MODE with retry ======
		var excludeIds []int
		for attempt := 1; attempt <= MaxCloudCodeGenerationAttempts; attempt++ {
			pool := GetAccountPool()
			acc, selErr := pool.SelectAccount(requestModelKey, excludeIds)
			if selErr != nil {
				Log("[proxy] #%d [LOCAL-POOL-GEMINI] No available account: %v", reqId, selErr)
				p.sendJsonError(w, 503, fmt.Sprintf("本地号池: %v", selErr))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			token, tokenErr := pool.GetAccessToken(acc.ID)
			if tokenErr != nil {
				Log("[proxy] #%d [LOCAL-POOL-GEMINI] Token refresh failed for #%d: %v", reqId, acc.ID, tokenErr)
				excludeIds = append(excludeIds, acc.ID)
				pool.MarkError(acc.ID)
				if attempt < MaxCloudCodeGenerationAttempts {
					continue
				}
				p.sendJsonError(w, 503, fmt.Sprintf("本地号池: token 刷新失败: %v", tokenErr))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			lease = &TokenLease{
				AccessToken: token,
				ProjectId:   acc.ProjectId,
				AccountId:   acc.ID,
				EmailHint:   acc.Email,
			}
			Log("[proxy] #%d [LOCAL-POOL-GEMINI] attempt=%d account=#%d (%s)", reqId, attempt, acc.ID, acc.Email)

			req, _ := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(body))
			for k, v := range r.Header {
				lower := strings.ToLower(k)
				if lower == "authorization" || lower == "host" || lower == "content-length" || lower == "x-goog-api-key" || lower == "x-goog-user-project" {
					continue
				}
				for _, val := range v {
					req.Header.Add(k, val)
				}
			}
			req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
			if lease.ProjectId != "" {
				req.Header.Set("X-Goog-User-Project", lease.ProjectId)
			}
			req.Header.Set("Host", targetUrl.Host)
			req.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))

			var doErr error
			resp, doErr = client.Do(req)
			if doErr != nil {
				Log("[proxy] #%d [LOCAL-POOL-GEMINI] upstream error: %v", reqId, doErr)
				p.sendJsonError(w, 502, fmt.Sprintf("Upstream error: %v", doErr))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}

			problemReason := ""
			if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusForbidden ||
				resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusInternalServerError ||
				resp.StatusCode == http.StatusBadRequest {
				respBytes := readAndResetResponseBody(resp)
				problemReason = cloudCodeAccountProblemReason(resp.StatusCode, string(respBytes))
			}
			if problemReason == "" {
				pool.MarkSuccess(acc.ID)
				pool.PostRequestHealthRefresh(acc.ID)
				break
			}

			Log("[proxy] #%d [LOCAL-POOL-GEMINI] account #%d returned %d (%s), rotating...", reqId, acc.ID, resp.StatusCode, problemReason)
			localRetryMs := extractQuotaResetDelayMs(string(readAndResetResponseBody(resp)))
			cooldownMin := 30
			if localRetryMs > 0 {
				cooldownMin = int(localRetryMs / 60000)
				if cooldownMin < 1 {
					cooldownMin = 1
				}
			}
			pool.MarkExhausted(acc.ID, problemReason, requestModelKey, cooldownMin)
			excludeIds = append(excludeIds, acc.ID)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			atomic.AddInt64(&p.stats.TotalRetries, 1)
			GetUsageStats().AddRetry()
			if attempt >= MaxCloudCodeGenerationAttempts {
				break
			}
		}
	} else {
		// ====== REMOTE LEASE MODE with retry (aligned with Cloud Code path) ======
		leaser := GetLeaser()
		// 本地额度检查
		if ok, waitMs, reason := leaser.CheckLocalQuota(requestModelKey); !ok {
			Log("[proxy] #%d [QUOTA-LOCAL] %s", reqId, reason)
			w.Header().Set("Retry-After", fmt.Sprintf("%d", waitMs/1000))
			p.sendJsonError(w, 429, fmt.Sprintf("BingchaAI: %s", reason))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
		remoteMaxAttempts := MaxCloudCodeGenerationAttempts
		accumulatedCapacityWaitMs := int64(0)
		const maxCapacityWaitMs = int64(60000)
		var excludeAccountIds []int

		for attempt := 1; attempt <= remoteMaxAttempts; attempt++ {
			leaseOptions := map[string]interface{}{
				"attemptSessionId": attemptSessionId,
				"modelKey":         requestModelKey,
			}
			if len(excludeAccountIds) > 0 {
				leaseOptions["excludeAccountIds"] = excludeAccountIds
			}
			var err error
			lease, err = leaser.LeaseToken(card, deviceId, attempt > 1, leaseOptions, upstream)
			if err != nil {
				Log("[proxy] #%d [TOKEN-ERROR] Failed to lease token for Gemini API: %v", reqId, err)
				p.sendJsonError(w, 503, fmt.Sprintf("租号服务暂时不可用，请稍后重试: %v", err))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			if lease.RetryPolicy != nil && lease.RetryPolicy.MaxAttempts > 0 {
				remoteMaxAttempts = lease.RetryPolicy.MaxAttempts
				if remoteMaxAttempts > 99 {
					remoteMaxAttempts = 99
				}
			}
			Log("[proxy] #%d [LEASE-GEMINI] attempt=%d/%d accountId=%d project=%s model=%s",
				reqId, attempt, remoteMaxAttempts, lease.AccountId, lease.ProjectId, requestModelKey)

			req, err := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(body))
			if err != nil {
				Log("[proxy] #%d [REQ-ERROR] Failed to build Gemini API request: %v", reqId, err)
				p.sendJsonError(w, 500, "Internal request creation error")
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			for k, v := range r.Header {
				lower := strings.ToLower(k)
				if lower == "authorization" || lower == "host" || lower == "content-length" ||
					lower == "x-goog-api-key" || lower == "x-goog-user-project" {
					continue
				}
				for _, val := range v {
					req.Header.Add(k, val)
				}
			}
			req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
			if lease.ProjectId != "" {
				req.Header.Set("X-Goog-User-Project", lease.ProjectId)
			}
			req.Header.Set("Host", targetUrl.Host)
			req.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))

			resp, err = client.Do(req)
			if err != nil {
				Log("[proxy] #%d [FORWARD-ERROR] Gemini API request failed: %v", reqId, err)
				p.sendJsonError(w, 502, fmt.Sprintf("Upstream gateway error: %v", err))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}

			problemReason := ""
			errorBody := ""
			if resp.StatusCode == http.StatusTooManyRequests ||
				resp.StatusCode == http.StatusForbidden ||
				resp.StatusCode == http.StatusServiceUnavailable ||
				resp.StatusCode == http.StatusInternalServerError ||
				resp.StatusCode == http.StatusBadRequest {
				respBytes := readAndResetResponseBody(resp)
				errorBody = string(respBytes)
				problemReason = cloudCodeAccountProblemReason(resp.StatusCode, errorBody)
			}
			if problemReason == "" {
				break
			}

			retryAfterMs := extractQuotaResetDelayMs(errorBody)
			errorModelKey := extractCapacityModelKey(errorBody)
			if errorModelKey == "" {
				errorModelKey = requestModelKey
			}
			reportDetails := ReportDetails{
				StatusCode:   resp.StatusCode,
				ModelKey:     errorModelKey,
				Reason:       problemReason,
				RetryAfterMs: retryAfterMs,
				ErrorText:    errorBody,
			}

			// Verification challenge → report + rotate to another account
			if resp.StatusCode == http.StatusForbidden && isVerificationChallengeError(errorBody) {
				Log("[proxy] #%d [VERIFY-GEMINI] Verification challenge for accountId=%d, rotating (%d/%d)",
					reqId, lease.AccountId, attempt, remoteMaxAttempts)
				leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
				excludeAccountIds = append(excludeAccountIds, lease.AccountId)
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				resp = nil
				if attempt < remoteMaxAttempts {
					atomic.AddInt64(&p.stats.TotalRetries, 1)
					GetUsageStats().AddRetry()
					time.Sleep(remoteRetryDelayForStatus(attempt, http.StatusForbidden))
					continue
				}
				Log("[proxy] #%d [VERIFY-GEMINI] Verification challenge exhausted after %d attempts", reqId, attempt)
				p.sendJsonError(w, 503, "Remote account temporarily unavailable (verification required). Please retry.")
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}

			// Check retryability from server policy
			// #5: Use statusMaxAttempts to expand retry limit for specific status codes
			effectiveMaxAttempts := remoteMaxAttempts
			if lease.RetryPolicy != nil && lease.RetryPolicy.StatusMaxAttempts != nil {
				if statusLimit, ok := lease.RetryPolicy.StatusMaxAttempts[resp.StatusCode]; ok && statusLimit > effectiveMaxAttempts {
					effectiveMaxAttempts = statusLimit
					if effectiveMaxAttempts > 99 {
						effectiveMaxAttempts = 99
					}
				}
			}
			canRetry := attempt < effectiveMaxAttempts
			if lease.RetryPolicy != nil && len(lease.RetryPolicy.RetryableStatuses) > 0 {
				statusRetryable := false
				for _, s := range lease.RetryPolicy.RetryableStatuses {
					if s == resp.StatusCode {
						statusRetryable = true
						break
					}
				}
				if !statusRetryable {
					canRetry = false
				}
			}

			// #3: Short rate-limit (<5s RATE_LIMIT_EXCEEDED) — wait and retry SAME account
			if resp.StatusCode == http.StatusTooManyRequests &&
				retryAfterMs > 0 && retryAfterMs < 5000 &&
				strings.Contains(errorBody, "RATE_LIMIT_EXCEEDED") &&
				attempt < effectiveMaxAttempts+2 {
				waitMs := retryAfterMs + 500
				Log("[proxy] #%d [SHORT-RATELIMIT-GEMINI] 429 retryAfter=%dms, waiting %dms, same account=%d",
					reqId, retryAfterMs, waitMs, lease.AccountId)
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				resp = nil
				time.Sleep(time.Duration(waitMs) * time.Millisecond)
				continue
			}

			// 503 capacity wait — wait and retry instead of immediate rotate
			if resp.StatusCode == http.StatusServiceUnavailable &&
				strings.Contains(strings.ToLower(errorBody), "capacity") &&
				accumulatedCapacityWaitMs < maxCapacityWaitMs {
				waitMs := int64(5000)
				if retryAfterMs > 0 && retryAfterMs < 30000 {
					waitMs = retryAfterMs
				}
				accumulatedCapacityWaitMs += waitMs
				Log("[proxy] #%d [CAPACITY-WAIT-GEMINI] 503 capacity, waiting %dms (total=%dms/%dms) model=%s",
					reqId, waitMs, accumulatedCapacityWaitMs, maxCapacityWaitMs, errorModelKey)
				leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				resp = nil
				time.Sleep(time.Duration(waitMs) * time.Millisecond)
				continue
			}

			if canRetry {
				respStatus := resp.StatusCode
				Log("[proxy] #%d Gemini API returned %d (%s) model=%s retryAfter=%dms accountId=%d; rotating (%d/%d)",
					reqId, respStatus, problemReason, errorModelKey, retryAfterMs, lease.AccountId, attempt, remoteMaxAttempts)
				leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
				excludeAccountIds = append(excludeAccountIds, lease.AccountId)
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				resp = nil
				atomic.AddInt64(&p.stats.TotalRetries, 1)
				GetUsageStats().AddRetry()
				time.Sleep(remoteRetryDelayForStatus(attempt, respStatus))
				continue
			}

			Log("[proxy] #%d Gemini API returned %d (%s) after %d attempts for accountId=%d, reporting...",
				reqId, resp.StatusCode, problemReason, attempt, lease.AccountId)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			break
		}
	} // end mode selection

	if resp == nil {
		p.sendJsonError(w, 502, "Upstream gateway error: no response after retries")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	defer resp.Body.Close()

	// [P3 TIMO-STYLE] 首 chunk 缓冲：在 WriteHeader 之前先读第一个 chunk
	isStreaming := strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") ||
		strings.Contains(strings.ToLower(r.URL.Path), "streamgeneratecontent")
	var firstChunk []byte
	if isStreaming {
		buf := make([]byte, 8192)
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			firstChunk = make([]byte, n)
			copy(firstChunk, buf[:n])
			if reason, mk, retryMs := checkStreamingQuotaError(string(firstChunk)); reason != "" {
				Log("[proxy] #%d [FIRST-CHUNK-ERROR-GEMINI] %s in first chunk model=%s retryAfter=%dms",
					reqId, reason, mk, retryMs)
				_ = resp.Body.Close()
				if isLocalPool && lease != nil {
					pool := GetAccountPool()
					cooldownMin := 30
					if retryMs > 0 {
						cooldownMin = int(retryMs / 60000)
						if cooldownMin < 1 { cooldownMin = 1 }
					}
					pool.MarkExhausted(lease.AccountId, reason, mk, cooldownMin)
				} else if lease != nil {
					statusCode := 429
					if reason == "capacity" { statusCode = 503 }
					GetLeaser().ReportProblemWithDetails(card, deviceId, ReportDetails{
						StatusCode: statusCode, ModelKey: mk, Reason: reason, RetryAfterMs: retryMs,
					}, upstream, lease)
				}
				p.sendJsonError(w, 429, fmt.Sprintf("Account quota exhausted (%s), please retry", reason))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
		}
		if readErr != nil && readErr != io.EOF {
			Log("[proxy] #%d [FIRST-CHUNK-GEMINI] read error: %v", reqId, readErr)
		}
	}

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(resp.StatusCode)

	p.mu.Lock()
	p.lastModelKey = requestModelKey
	p.mu.Unlock()

	var tokenResult TokenUsageResult
	if isStreaming {
		if len(firstChunk) > 0 {
			_, _ = w.Write(firstChunk)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		tokenResult = p.streamResponse(w, resp.Body, reqId)
		if len(firstChunk) > 0 {
			tokenResult.StreamBytes += int64(len(firstChunk))
		}
	} else {
		respBytes, err := io.ReadAll(resp.Body)
		if err == nil {
			_, _ = w.Write(respBytes)
			tokenResult = p.parseAndAddTokenUsage(respBytes, resp.Header.Get("Content-Encoding"), requestModelKey)
		}
	}

	// [TIMO-STYLE] 流式中途 quota 错误：上报 + 标记账号
	if tokenResult.StreamError {
		Log("[proxy] #%d [STREAM-QUOTA-REPORT-GEMINI] reporting mid-stream %s for model=%s",
			reqId, tokenResult.StreamErrorReason, tokenResult.StreamErrorModel)
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
		if isLocalPool && lease != nil {
			pool := GetAccountPool()
			cooldownMin := 30
			if tokenResult.StreamRetryAfterMs > 0 {
				cooldownMin = int(tokenResult.StreamRetryAfterMs / 60000)
				if cooldownMin < 1 { cooldownMin = 1 }
			}
			pool.MarkExhausted(lease.AccountId, tokenResult.StreamErrorReason, tokenResult.StreamErrorModel, cooldownMin)
		} else if lease != nil {
			leaser := GetLeaser()
			statusCode := 429
			if tokenResult.StreamErrorReason == "capacity" { statusCode = 503 }
			leaser.ReportProblemWithDetails(card, deviceId, ReportDetails{
				StatusCode:   statusCode,
				ModelKey:     tokenResult.StreamErrorModel,
				Reason:       tokenResult.StreamErrorReason,
				RetryAfterMs: tokenResult.StreamRetryAfterMs,
			}, upstream, lease)
		}
		return
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		atomic.AddInt64(&p.stats.TotalSuccessfulGenerations, 1)
		GetUsageStats().AddGeneration()
		// 上报成功请求的 token 用量到服务器，不释放 lease（保持账号粘性）
		if lease != nil && !isLocalPool {
			leaser := GetLeaser()
			// 本地记账
			if tokenResult.BillableTotalTokens > 0 {
				leaser.RecordLocalUsage(requestModelKey, int64(tokenResult.BillableTotalTokens))
			}
			leaser.ReportUsage(card, deviceId, ReportDetails{
				StatusCode:          resp.StatusCode,
				ModelKey:            requestModelKey,
				InputTokens:         tokenResult.InputTokens,
				OutputTokens:        tokenResult.OutputTokens,
				CachedInputTokens:   tokenResult.CachedInputTokens,
				RawTotalTokens:      tokenResult.RawTotalTokens,
				BillableTotalTokens: tokenResult.BillableTotalTokens,
			}, upstream, lease)
			// 影子校验通道
			if tokenResult.RawTotalTokens > 0 {
				go leaser.syncMetrics(card, lease,
					tokenResult.InputTokens, tokenResult.OutputTokens,
					tokenResult.CachedInputTokens, tokenResult.RawTotalTokens,
					tokenResult.StreamBytes, requestModelKey, upstream)
			}
		}
	} else {
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
	}
}

func (p *ProxyServer) forwardToGoogle(w http.ResponseWriter, r *http.Request, body []byte, upstream string, reqId int64) {
	endpoint := upstreamEndpointForPath(r.URL.Path)
	targetUrl, _ := url.Parse(endpoint + r.URL.Path + "?" + r.URL.RawQuery)

	isNoise := isNoiseRequest(r.URL.Path)

	client := createHttpClient(upstream)

	// 带重试的请求（解决启动时连接池冷启动 EOF 问题）
	const maxForwardRetries = 5
	var resp *http.Response
	var lastErr error
	for attempt := 1; attempt <= maxForwardRetries; attempt++ {
		req, err := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(body))
		if err != nil {
			p.sendJsonError(w, 500, "Internal request error")
			return
		}
		for k, v := range r.Header {
			if strings.ToLower(k) == "host" {
				continue
			}
			for _, val := range v {
				req.Header.Add(k, val)
			}
		}
		req.Header.Set("Host", targetUrl.Host)

		resp, lastErr = client.Do(req)
		if lastErr == nil {
			break // 成功
		}

		// EOF/连接错误 → 短暂等待后重试
		if attempt < maxForwardRetries {
			backoff := time.Duration(attempt) * time.Second
			Log("[proxy] #%d Forward attempt %d/%d failed: %v, retrying in %v...", reqId, attempt, maxForwardRetries, lastErr, backoff)
			time.Sleep(backoff)
			continue
		}
	}

	if lastErr != nil {
		Log("[proxy] #%d Forward failed after %d attempts: %v", reqId, maxForwardRetries, lastErr)
		if fallback, ok := ideFallbackPayload(r.URL.Path); ok {
			Log("[proxy] #%d [FALLBACK] Serving IDE fallback after upstream failure", reqId)
			p.sendJson(w, 200, fallback)
			return
		}
		p.sendJsonError(w, 502, fmt.Sprintf("Upstream unavailable: %v", lastErr))
		return
	}
	defer resp.Body.Close()

	// Debug: log response for non-noise requests
	if !isNoise {
		respBody, _ := io.ReadAll(resp.Body)
		Log("[proxy] #%d [DEBUG] <- Status: %d, Body(%d bytes): %s", reqId, resp.StatusCode, len(respBody), debugResponseBody(respBody, resp.Header.Get("Content-Encoding"), 500))

		// Copy headers
		for k, v := range resp.Header {
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBody)
	} else {
		// Copy headers
		for k, v := range resp.Header {
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}


func (p *ProxyServer) streamResponse(w http.ResponseWriter, body io.Reader, reqId int64) TokenUsageResult {
	buffer := make([]byte, 32768) // 32KB read buffer（减少系统调用，提升流式吞吐）
	// 尾部缓冲：仅保留流的最后 16KB 用于解析 token 用量（usageMetadata 只出现在末尾）
	var tailBuffer bytes.Buffer
	const tailBufferMax = 16384
	streamQuotaDetected := false

	// 滑动窗口缓冲：防止 quota 错误 JSON 被 chunk 边界切断（timo 使用 Rust async stream 无此问题）
	var recentWindow bytes.Buffer
	const recentWindowMax = 4096

	// 流式错误信息，用于通知调用方上报
	var streamErrorReason, streamErrorModel string
	var streamRetryAfterMs int64
	var totalStreamBytes int64

	flusher, ok := w.(http.Flusher)

	// P1⑦: Stream inactivity timer with keepalive
	const streamFirstByteTimeout = 180 * time.Second  // 3 min for initial thinking
	const streamMidCheckInterval = 60 * time.Second    // 60s between health checks
	const streamGracePeriod = 30 * time.Second         // 30s per grace extension
	streamMaxIdle := 5 * time.Minute                   // default max idle

	var streamHasData atomic.Bool
	var lastDataNano atomic.Int64
	lastDataNano.Store(time.Now().UnixNano())
	var streamTimedOut atomic.Bool

	// Timer goroutine
	done := make(chan struct{})
	defer close(done)

	go func() {
		firstTimeout := time.After(streamFirstByteTimeout)
		select {
		case <-done:
			return
		case <-firstTimeout:
			if !streamHasData.Load() {
				streamTimedOut.Store(true)
				Log("[proxy] #%d [STREAM-TIMEOUT] First byte timeout (%ds)", reqId, int(streamFirstByteTimeout.Seconds()))
				if closer, ok := body.(io.Closer); ok {
					closer.Close()
				}
				return
			}
		}

		// Mid-stream health checks
		ticker := time.NewTicker(streamMidCheckInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				idleDuration := time.Since(time.Unix(0, lastDataNano.Load()))
				if idleDuration >= streamMaxIdle {
					streamTimedOut.Store(true)
					Log("[proxy] #%d [STREAM-TIMEOUT] Max idle %ds exceeded", reqId, int(idleDuration.Seconds()))
					if closer, ok := body.(io.Closer); ok {
						closer.Close()
					}
					return
				}
				// Send SSE keepalive comment
				if ok && !streamTimedOut.Load() {
					_, writeErr := w.Write([]byte(fmt.Sprintf(": bcai-keepalive %d\n\n", time.Now().UnixMilli())))
					if writeErr == nil {
						flusher.Flush()
					}
				}
				Log("[proxy] #%d [STREAM] idle %ds, socket alive, grace +%ds",
					reqId, int(idleDuration.Seconds()), int(streamGracePeriod.Seconds()))
			}
		}
	}()

	for {
		n, err := body.Read(buffer)
		if n > 0 {
			totalStreamBytes += int64(n)
			_, _ = tailBuffer.Write(buffer[:n])
			if tailBuffer.Len() > tailBufferMax {
				tailBuffer.Next(tailBuffer.Len() - tailBufferMax)
			}
			streamHasData.Store(true)
			lastDataNano.Store(time.Now().UnixNano())

			// 更新滑动窗口（用于跨 chunk 检测）
			recentWindow.Write(buffer[:n])
			if recentWindow.Len() > recentWindowMax {
				recentWindow.Next(recentWindow.Len() - recentWindowMax)
			}

			// [TIMO-STYLE] 检测 mid-stream quota/capacity 错误
			// timo 检测到后：中断流 + toast 通知 + 换号重试
			// 插件检测到后：proxyRes.destroy() + res.end() + reportRemoteResult
			// 我们参照两者：中断上游 + 停止转发 + 通知调用方上报
			if !streamQuotaDetected {
				if reason, modelKey, retryAfterMs := checkStreamingQuotaError(recentWindow.String()); reason != "" {
					streamQuotaDetected = true
					streamErrorReason = reason
					streamErrorModel = modelKey
					streamRetryAfterMs = retryAfterMs

					Log("[proxy] #%d [STREAM-QUOTA] %s detected mid-stream model=%s retryAfter=%dms, aborting stream (timo-style)",
						reqId, reason, modelKey, retryAfterMs)

					// 1. 中断上游连接（停止从 Google 读取更多数据）
					if closer, ok := body.(io.Closer); ok {
						closer.Close()
					}
					// 2. 向 IDE 发送 SSE 结束标记，避免 IDE 侧无限等待
					if ok {
						_, _ = w.Write([]byte("\ndata: [DONE]\n\n"))
						flusher.Flush()
					}
					Log("[proxy] #%d [STREAM-QUOTA] upstream destroyed, stream ended with [DONE]", reqId)
					break // 退出读取循环
				}
			}

			// 只有在非 quota 中断的情况下才转发数据给 IDE
			_, writeErr := w.Write(buffer[:n])
			if ok {
				flusher.Flush()
			}
			// 下游断开（broken pipe）→ 停止从上游读取，节省 API 配额
			if writeErr != nil {
				Log("[proxy] #%d [STREAM] downstream write error, aborting: %v", reqId, writeErr)
				if closer, cOk := body.(io.Closer); cOk {
					closer.Close()
				}
				break
			}
		}
		if err != nil {
			if err != io.EOF && !streamTimedOut.Load() {
				Log("[proxy] #%d Stream read error: %v", reqId, err)
			}
			break
		}
	}

	// Parse cumulative tokens from the stream
	p.mu.Lock()
	modelKey := p.lastModelKey
	p.mu.Unlock()
	result := p.parseAndAddTokenUsage(tailBuffer.Bytes(), "", modelKey)

	// 附加流式错误信息，通知调用方上报
	if streamQuotaDetected {
		result.StreamError = true
		result.StreamErrorReason = streamErrorReason
		result.StreamErrorModel = streamErrorModel
		result.StreamRetryAfterMs = streamRetryAfterMs
		result.StreamBytes = totalStreamBytes
	}
	return result
}

// TokenUsageResult holds parsed token counts and the billable total after
// applying the cached-token discount (cached tokens count as 1/10).
type TokenUsageResult struct {
	InputTokens       int64
	OutputTokens      int64
	CachedInputTokens int64
	RawTotalTokens    int64
	BillableTotalTokens int64 // rawTotal - cached + ceil(cached/10)
	// Mid-stream quota/capacity error (timo-style detection)
	StreamError        bool
	StreamErrorReason  string // "quota" or "capacity"
	StreamErrorModel   string
	StreamRetryAfterMs int64
	StreamBytes        int64  // bytes received before error
}

// discountedCachedTokens returns the billable portion of cached tokens.
// Cached tokens are billed at 1/10 of their count (ceil), matching the
// plugin's discountedCachedTokens (token-proxy.js L306-309).
func discountedCachedTokens(cached int64) int64 {
	if cached <= 0 {
		return 0
	}
	return (cached + 9) / 10 // ceil(cached / 10)
}

func (p *ProxyServer) parseAndAddTokenUsage(data []byte, contentEncoding string, modelKey string) TokenUsageResult {
	var text string
	if strings.Contains(strings.ToLower(contentEncoding), "gzip") {
		gr, err := gzip.NewReader(bytes.NewReader(data))
		if err == nil {
			defer gr.Close()
			decompressed, err := io.ReadAll(gr)
			if err == nil {
				text = string(decompressed)
			}
		}
	} else {
		text = string(data)
	}

	if text == "" {
		text = string(data)
	}

	// Simple regex/substring searches for token counts inside JSON
	inputTokens := extractFieldCount(text, "promptTokenCount", "inputTokenCount", "promptTokens", "inputTokens")
	outputTokens := extractFieldCount(text, "candidatesTokenCount", "outputTokenCount", "completionTokens", "outputTokens")
	// thoughtsTokenCount 累加到 output（与插件 token-proxy.js L337-339 一致）
	thoughtTokens := extractFieldCount(text, "thoughtsTokenCount")
	if thoughtTokens > 0 {
		outputTokens += thoughtTokens
	}
	cachedTokens := extractFieldCount(text, "cachedContentTokenCount", "cachedPromptTokenCount", "cacheTokenCount", "cachedInputTokens")
	// cachedInputTokens 不能超过 inputTokens
	if cachedTokens > inputTokens {
		cachedTokens = inputTokens
	}

	// 计算 rawTotal 和 billable（缓存 token 按 1/10 计费）
	rawTotal := inputTokens + outputTokens
	var billable int64
	if cachedTokens > 0 {
		// billable = rawTotal - cachedInput + ceil(cachedInput/10)
		billable = rawTotal - cachedTokens + discountedCachedTokens(cachedTokens)
		if billable < 0 {
			billable = 0
		}
	} else {
		billable = rawTotal
	}

	if inputTokens > 0 || outputTokens > 0 {
		Log("[proxy] Token usage: input=%d, output=%d, cached=%d, thought=%d, billable=%d model=%s",
			inputTokens, outputTokens, cachedTokens, thoughtTokens, billable, modelKey)
	}

	if inputTokens > 0 {
		atomic.AddInt64(&p.stats.TotalInputTokens, inputTokens)
	}
	if outputTokens > 0 {
		atomic.AddInt64(&p.stats.TotalOutputTokens, outputTokens)
	}
	if cachedTokens > 0 {
		atomic.AddInt64(&p.stats.TotalCachedTokens, cachedTokens)
	}

	// 按模型分类累加
	category := classifyModel(modelKey)
	switch category {
	case "opus":
		if inputTokens > 0 {
			atomic.AddInt64(&p.stats.OpusInputTokens, inputTokens)
		}
		if outputTokens > 0 {
			atomic.AddInt64(&p.stats.OpusOutputTokens, outputTokens)
		}
	case "gemini":
		if inputTokens > 0 {
			atomic.AddInt64(&p.stats.GeminiInputTokens, inputTokens)
		}
		if outputTokens > 0 {
			atomic.AddInt64(&p.stats.GeminiOutputTokens, outputTokens)
		}
	}

	// 持久化到每日统计
	if inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 {
		GetUsageStats().AddTokens(inputTokens, outputTokens, cachedTokens)
	}

	return TokenUsageResult{
		InputTokens:       inputTokens,
		OutputTokens:      outputTokens,
		CachedInputTokens: cachedTokens,
		RawTotalTokens:    rawTotal,
		BillableTotalTokens: billable,
	}
}

func extractFieldCount(text string, fields ...string) int64 {
	var maxCount int64 = 0
	for _, field := range fields {
		// Custom simple regex match
		idx := 0
		for {
			loc := strings.Index(text[idx:], fmt.Sprintf(`"%s"`, field))
			if loc == -1 {
				break
			}
			start := idx + loc + len(field) + 2
			// Search for colon and then digit
			colonIdx := strings.Index(text[start:], ":")
			if colonIdx != -1 {
				digitStart := start + colonIdx + 1
				// skip whitespace
				for digitStart < len(text) && (text[digitStart] == ' ' || text[digitStart] == '\t' || text[digitStart] == '\r' || text[digitStart] == '\n') {
					digitStart++
				}
				digitEnd := digitStart
				for digitEnd < len(text) && text[digitEnd] >= '0' && text[digitEnd] <= '9' {
					digitEnd++
				}
				if digitEnd > digitStart {
					var count int64
					_, err := fmt.Sscanf(text[digitStart:digitEnd], "%d", &count)
					if err == nil && count > maxCount {
						maxCount = count
					}
				}
			}
			idx += loc + len(field) + 2
		}
	}
	return maxCount
}

func (p *ProxyServer) sendJson(w http.ResponseWriter, code int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

func (p *ProxyServer) sendJsonError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]interface{}{
			"code":    code,
			"message": message,
			"status":  "UNAVAILABLE",
		},
	})
}

// Check if project or projectId field exists anywhere in the JSON body
func hasProjectField(val interface{}) bool {
	switch v := val.(type) {
	case map[string]interface{}:
		for k, child := range v {
			if isProjectFieldName(k) {
				return true
			}
			if hasProjectField(child) {
				return true
			}
		}
	case []interface{}:
		for _, child := range v {
			if hasProjectField(child) {
				return true
			}
		}
	}
	return false
}

// Rewrite project and projectId fields
func rewriteProjectFields(val interface{}, projectId string) (interface{}, bool) {
	updated := false
	switch v := val.(type) {
	case map[string]interface{}:
		newMap := make(map[string]interface{})
		for k, child := range v {
			if isProjectFieldName(k) {
				newMap[k] = formatProjectId(child, projectId)
				updated = true
			} else {
				rewrittenChild, childUpdated := rewriteProjectFields(child, projectId)
				newMap[k] = rewrittenChild
				if childUpdated {
					updated = true
				}
			}
		}
		return newMap, updated
	case []interface{}:
		newList := make([]interface{}, len(v))
		for i, child := range v {
			rewrittenChild, childUpdated := rewriteProjectFields(child, projectId)
			newList[i] = rewrittenChild
			if childUpdated {
				updated = true
			}
		}
		return newList, updated
	}
	return val, updated
}

func isProjectFieldName(key string) bool {
	return key == "project" || key == "projectId"
}

func formatProjectId(current interface{}, target string) string {
	currStr, ok := current.(string)
	if !ok {
		return target
	}
	currStr = strings.TrimSpace(currStr)
	if currStr == "" {
		return target
	}
	if strings.HasPrefix(strings.ToLower(currStr), "projects/") {
		return "projects/" + target
	}
	return target
}

func readAndResetResponseBody(resp *http.Response) []byte {
	if resp == nil || resp.Body == nil {
		return nil
	}
	respBytes, _ := io.ReadAll(resp.Body)
	resp.Body = io.NopCloser(bytes.NewReader(respBytes))
	return respBytes
}

func accountIdsFromSet(values map[int]bool) []int {
	ids := make([]int, 0, len(values))
	for id := range values {
		if id > 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

func cloudCodeAccountProblemReason(statusCode int, body string) string {
	lowerBody := strings.ToLower(body)
	googleStatus, googleDetailReason := googleErrorStatusAndReason(body)
	switch statusCode {
	case http.StatusBadRequest:
		// #2: Detect location_unsupported errors (mirrors token-proxy.js L900-908)
		if isLocationUnsupportedError(lowerBody) {
			return buildAccountProblemReason(statusCode, "location_unsupported")
		}
		return ""
	case http.StatusTooManyRequests:
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "too_many_requests"))
	case http.StatusForbidden:
		if strings.Contains(lowerBody, "service_disabled") ||
			strings.Contains(lowerBody, "cloud code private api") ||
			strings.Contains(lowerBody, "cloudcode-pa.googleapis.com") ||
			strings.Contains(lowerBody, "api has not been used in project") ||
			strings.Contains(lowerBody, "enable it by visiting") {
			return buildAccountProblemReason(statusCode, "service_disabled")
		}
		if strings.Contains(lowerBody, "verify") || strings.Contains(lowerBody, "validation") {
			return buildAccountProblemReason(statusCode, "account_verification_required")
		}
		if strings.Contains(lowerBody, "permission_denied") && strings.Contains(lowerBody, "cloudcode-pa.googleapis.com") {
			return buildAccountProblemReason(statusCode, "service_disabled")
		}
		if googleStatus != "" || googleDetailReason != "" {
			return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "forbidden"))
		}
		return buildAccountProblemReason(statusCode, "forbidden")
	case http.StatusServiceUnavailable:
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "service_unavailable"))
	case http.StatusInternalServerError:
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "internal_error"))
	}
	return ""
}

func googleErrorStatusAndReason(body string) (string, string) {
	var payload struct {
		Error struct {
			Status  string                   `json:"status"`
			Details []map[string]interface{} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return "", ""
	}

	for _, detail := range payload.Error.Details {
		if reason, ok := detail["reason"].(string); ok && reason != "" {
			return payload.Error.Status, reason
		}
	}
	return payload.Error.Status, ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func buildAccountProblemReason(statusCode int, reason string) string {
	return sanitizeAccountProblemReason(fmt.Sprintf("http_%d_%s", statusCode, reason))
}

func sanitizeAccountProblemReason(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastUnderscore := false

	for _, r := range value {
		isAlphaNum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlphaNum {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}

	result := strings.Trim(b.String(), "_")
	if len(result) > 120 {
		result = result[:120]
	}
	return result
}

// Mock models list response
func buildFallbackModels() map[string]interface{} {
	return map[string]interface{}{
		"models": map[string]interface{}{
			"MODEL_GOOGLE_GEMINI_2_5_FLASH": map[string]interface{}{
				"modelId":     "MODEL_GOOGLE_GEMINI_2_5_FLASH",
				"displayName": "Gemini 2.5 Flash",
				"model":       312,
				"apiProvider": 24,
			},
			"MODEL_CLAUDE_4_5_SONNET_THINKING": map[string]interface{}{
				"modelId":     "MODEL_CLAUDE_4_5_SONNET_THINKING",
				"displayName": "Claude 4.5 Sonnet (Thinking)",
				"model":       334,
				"apiProvider": 26,
			},
		},
		"defaultAgentModelId": "MODEL_GOOGLE_GEMINI_2_5_FLASH",
	}
}

// ─── P0/P1: Model Key Extraction ──────────────────────────────────────────

// extractModelKeyFromPath 从 URL 路径提取模型名
// 例如: /v1beta/models/gemini-2.5-pro:streamGenerateContent → gemini-2.5-pro
func extractModelKeyFromPath(path string) string {
	re := regexp.MustCompile(`models/([^/:]+)`)
	matches := re.FindStringSubmatch(path)
	if len(matches) >= 2 {
		return matches[1]
	}
	return ""
}

// extractModelKeyFromBody parses the JSON request body and recursively finds
// the first "model" string field — same behavior as the extension's
// extractModelKeyFromBody (token-proxy.js L554-566).
func extractModelKeyFromBody(body []byte) string {
	var parsed interface{}
	if json.Unmarshal(body, &parsed) != nil {
		return ""
	}
	return findFirstStringByKey(parsed, "model")
}

func findFirstStringByKey(v interface{}, key string) string {
	switch val := v.(type) {
	case map[string]interface{}:
		if s, ok := val[key].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
		for _, child := range val {
			if r := findFirstStringByKey(child, key); r != "" {
				return r
			}
		}
	case []interface{}:
		for _, item := range val {
			if r := findFirstStringByKey(item, key); r != "" {
				return r
			}
		}
	}
	return ""
}

// ─── P0: Quota Reset Delay Parsing ────────────────────────────────────────

// extractQuotaResetDelayMs parses the 429 error response to extract the
// precise cooldown duration — mirrors the extension's extractQuotaResetDelayMs
// (token-proxy.js L794-857). Supports:
//   - error.details[].metadata.quotaResetDelay  ("5h30m0s")
//   - error.details[].metadata.quotaResetTimeStamp  (ISO timestamp)
//   - error.message  "reset after 4h59m35s"
//   - "refresh on 5/24/2026, 3:00 AM"
func extractQuotaResetDelayMs(errorText string) int64 {
	if errorText == "" {
		return 0
	}

	// Try JSON structured parsing first
	var payload struct {
		Error struct {
			Message string                   `json:"message"`
			Details []map[string]interface{} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(errorText), &payload) == nil {
		for _, detail := range payload.Error.Details {
			metadata, _ := detail["metadata"].(map[string]interface{})
			if metadata == nil {
				continue
			}
			// quotaResetDelay: "5h30m0s"
			if delay, ok := metadata["quotaResetDelay"].(string); ok && delay != "" {
				if ms := parseDurationToMs(delay); ms > 0 {
					return ms
				}
			}
			// quotaResetTimeStamp: ISO timestamp
			if ts, ok := metadata["quotaResetTimeStamp"].(string); ok && ts != "" {
				if t, err := time.Parse(time.RFC3339, ts); err == nil {
					ms := t.UnixMilli() - time.Now().UnixMilli()
					if ms > 0 {
						return ms
					}
				}
			}
		}
		// Try parsing duration from error.message: "reset after 4h59m35s"
		if ms := parseDurationToMs(payload.Error.Message); ms > 0 {
			return ms
		}
	}

	// Fallback: regex "reset after 4h59m35s"
	re := regexp.MustCompile(`(?i)reset after ([^.:]+(?:\.\d+)?s)`)
	if m := re.FindStringSubmatch(errorText); len(m) > 1 {
		if ms := parseDurationToMs(m[1]); ms > 0 {
			return ms
		}
	}

	// Try full text duration parse
	if ms := parseDurationToMs(errorText); ms > 0 {
		return ms
	}

	return 0
}

// parseDurationToMs parses human-readable durations like "5h30m10s" → milliseconds.
// Mirrors the extension's parseDurationToMs (token-proxy.js L752-779).
func parseDurationToMs(text string) int64 {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	re := regexp.MustCompile(`(\d+(?:\.\d+)?)(h|m|s)`)
	matches := re.FindAllStringSubmatch(strings.ToLower(text), -1)
	if len(matches) == 0 {
		return 0
	}
	var totalMs float64
	for _, m := range matches {
		amount, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		switch m[2] {
		case "h":
			totalMs += amount * 3600000
		case "m":
			totalMs += amount * 60000
		case "s":
			totalMs += amount * 1000
		}
	}
	return int64(math.Ceil(totalMs))
}

// ─── P0: Capacity Model Key Extraction ────────────────────────────────────

// extractCapacityModelKey extracts model name from 503 capacity error responses.
// Mirrors the extension's extractCapacityModelKey (token-proxy.js L731-749).
func extractCapacityModelKey(errorText string) string {
	if errorText == "" {
		return ""
	}
	// Try structured JSON first
	var payload struct {
		Error struct {
			Details []struct {
				Metadata struct {
					Model string `json:"model"`
				} `json:"metadata"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(errorText), &payload) == nil {
		for _, d := range payload.Error.Details {
			if strings.TrimSpace(d.Metadata.Model) != "" {
				return strings.TrimSpace(d.Metadata.Model)
			}
		}
	}
	// Regex fallback
	re := regexp.MustCompile(`(?i)No capacity available for model ([A-Za-z0-9._-]+)`)
	if m := re.FindStringSubmatch(errorText); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

// ─── P1: Streaming Mid-Stream Quota Detection ─────────────────────────────

// checkStreamingQuotaError detects quota/capacity exhaustion errors in
// streaming response chunks. Mirrors the extension's getStreamingRotationDetails
// (token-proxy.js L943-971).
func checkStreamingQuotaError(chunk string) (reason, modelKey string, retryAfterMs int64) {
	lower := strings.ToLower(chunk)
	mk := extractCapacityModelKey(chunk)

	if strings.Contains(lower, "baseline model quota reached") ||
		strings.Contains(lower, "quota reached") ||
		strings.Contains(lower, "quota_exhausted") ||
		strings.Contains(lower, "resource_exhausted") {
		return "quota", mk, extractQuotaResetDelayMs(chunk)
	}
	if strings.Contains(lower, "model_capacity_exhausted") ||
		strings.Contains(lower, "no capacity available") ||
		strings.Contains(lower, "capacity available for model") {
		return "capacity", mk, extractQuotaResetDelayMs(chunk)
	}
	return "", "", 0
}

// ─── P1: Exponential Backoff Delay ────────────────────────────────────────

// remoteRetryDelay calculates exponential backoff for remote lease retries.
// Mirrors the extension's remoteRetryDelayMs (token-proxy.js L45-51).
// base=250ms, multiplier=1.3, jitter=0-500ms, max=5000ms
func remoteRetryDelay(attempt int) time.Duration {
	base := 250.0
	multiplier := 1.3
	delay := base * math.Pow(multiplier, float64(attempt-1))
	jitter := rand.Float64() * 500
	total := math.Min(5000, delay+jitter)
	return time.Duration(total) * time.Millisecond
}

// remoteRetryDelayForStatus returns a status-aware retry delay.
// Mirrors the extension's remoteStatusDelayMs (token-proxy.js L54-64).
// 503 gets at least capacityWait (2s), 429 gets at least quotaWait (1s).
func remoteRetryDelayForStatus(attempt int, statusCode int) time.Duration {
	baseDelay := remoteRetryDelay(attempt)
	switch statusCode {
	case http.StatusServiceUnavailable: // 503
		const capacityWaitMs = 2000
		if baseDelay < capacityWaitMs*time.Millisecond {
			return capacityWaitMs * time.Millisecond
		}
	case http.StatusTooManyRequests: // 429
		const quotaWaitMs = 1000
		if baseDelay < quotaWaitMs*time.Millisecond {
			return quotaWaitMs * time.Millisecond
		}
	}
	return baseDelay
}

// ─── P0: Enhanced Report Details ──────────────────────────────────────────

// ReportDetails contains enriched information for report-result, matching
// the fields sent by the extension's reportRemoteResult (token-proxy.js L1448-1477).
type ReportDetails struct {
	StatusCode        int
	ModelKey          string
	Reason            string
	RetryAfterMs      int64
	InputTokens       int64
	OutputTokens      int64
	CachedInputTokens int64 // 缓存命中的 input token（按 1/10 计费）
	RawTotalTokens    int64 // input + output 原始总量
	BillableTotalTokens int64 // 折扣后的计费总量
	ErrorText         string
}

// getErrorSnippet truncates error text for report payloads (max 1200 chars).
func getErrorSnippet(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 1200 {
		return text[:1200]
	}
	return text
}

// ─── P2⑪: Verification Challenge Detection ───────────────────────────────

// isVerificationChallengeError detects Google verification challenges in error
// responses. Mirrors the extension's isVerificationChallengeText (L910-929).
func isVerificationChallengeError(errorText string) bool {
	lower := strings.ToLower(errorText)
	return strings.Contains(lower, "please verify your account") ||
		strings.Contains(lower, "verify your account to continue") ||
		strings.Contains(lower, "verify account") ||
		strings.Contains(lower, "verify your info to continue") ||
		strings.Contains(lower, "google needs to verify") ||
		strings.Contains(lower, "verify some info about your device") ||
		strings.Contains(lower, "scan the qr code with your phone") ||
		strings.Contains(lower, "validation_required") ||
		strings.Contains(lower, "validation_url") ||
		strings.Contains(lower, "validation_error_message") ||
		strings.Contains(lower, "permission_denied") ||
		strings.Contains(lower, "al_alert")
}

// isLocationUnsupportedError detects Google "user location is not supported" errors.
// Mirrors the extension's isLocationUnsupportedText (token-proxy.js L900-908).
func isLocationUnsupportedError(lowerBody string) bool {
	return strings.Contains(lowerBody, "user location is not supported") ||
		strings.Contains(lowerBody, "location is not supported for the api use") ||
		(strings.Contains(lowerBody, "failed_precondition") &&
			strings.Contains(lowerBody, "location") &&
			strings.Contains(lowerBody, "not supported"))
}
