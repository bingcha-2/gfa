package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const DefaultCloudEndpoint = "https://cloudcode-pa.googleapis.com"
const DailyCloudEndpoint = "https://daily-cloudcode-pa.googleapis.com" // returns Claude/GPT third-party models (aligned with cockpit)
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

	// 可配置的流式超时参数（0 = 使用默认值）
	StreamMaxIdle      time.Duration // 默认 5 分钟
	StreamCheckInterval time.Duration // 默认 60 秒
}

var globalProxy = &ProxyServer{}

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
			if isHopByHopHeader(k) {
				continue
			}
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(200)
		_, _ = w.Write(respBody)
	} else {
		Log("[proxy] #%d [MODELS] <- %d, serving cache", reqId, resp.StatusCode)
		// 401 = token 过期或被吊销 → 强制清除缓存 token，下次 LeaseToken 会重新获取
		if resp.StatusCode == http.StatusUnauthorized {
			leaser := GetLeaser()
			leaser.ClearCache()
			Log("[proxy] #%d [MODELS] 401 → invalidated cached token", reqId)
		}
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
		for k, v := range resp.Header {
			if isHopByHopHeader(k) {
				continue
			}
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBody)
	} else {
		for k, v := range resp.Header {
			if isHopByHopHeader(k) {
				continue
			}
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
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

	if !isNoise {
		respBody, _ := io.ReadAll(resp.Body)
		// Copy headers
		for k, v := range resp.Header {
			if isHopByHopHeader(k) {
				continue
			}
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBody)
	} else {
		// Copy headers
		for k, v := range resp.Header {
			if isHopByHopHeader(k) {
				continue
			}
			for _, val := range v {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}

func (p *ProxyServer) sendJson(w http.ResponseWriter, code int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

// passthroughUpstreamError 把上游(Google)的错误原文按原状态码回给客户端,让 IDE 用它
// 自己的逻辑处理 —— 验证挑战(VALIDATION_REQUIRED / "Verify your account")这样就能触发
// Antigravity 自带的"验证账号"流程(带 validation_url 链接),而不是被代理吞成"繁忙"。
func (p *ProxyServer) passthroughUpstreamError(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(body))
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
