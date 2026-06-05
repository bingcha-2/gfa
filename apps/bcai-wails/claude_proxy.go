package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
)

// ─── Claude 本地代理(Anthropic /v1/messages 路由)──────────────────────────
//
// Claude Code / VSCode 扩展被注入 ANTHROPIC_BASE_URL=http://127.0.0.1:<port> 后,
// 生成请求落在 /v1/messages。本代理:换号池 token → 转发到 api.anthropic.com →
// 边流式回传边解析 SSE 用量(claude_sse.go)→ 上报服务端计费。
//
// 镜像 codex_proxy.go 的号池流程(lease → forward → stream-meter → report),但:
//   - 上游是 Anthropic,不是 chatgpt.com;
//   - 直接复用 Claude Code 自带的 anthropic-version / anthropic-beta / user-agent 头
//     (只把 Authorization 换成租来的 OAuth token,x-api-key 去掉),避免猜头猜错;
//   - 用量在 message_start/message_delta 的 usage 里(SSE),不在 response.completed。
//
// 出口:首版直连 api.anthropic.com(与 codex 直连 chatgpt 一致);粘性住宅代理/指纹
// 对齐的"出口层"按计划上线后灰度引入。

// ANTHROPIC_API_BASE 上游基址(可经 env 覆盖,默认官方域名)。
var ANTHROPIC_API_BASE = getEnvOrDefault("BCAI_ANTHROPIC_API_BASE", "https://api.anthropic.com")

// claudeOAuthBeta 是订阅号 OAuth token 必带的 anthropic-beta 值(对照 Claude Code 2.x)。
const claudeOAuthBeta = "oauth-2025-04-20"

// mergeAnthropicBeta 把 want 合并进逗号分隔的 anthropic-beta 头(已存在则不重复)。
func mergeAnthropicBeta(existing, want string) string {
	existing = strings.TrimSpace(existing)
	if existing == "" {
		return want
	}
	for _, part := range strings.Split(existing, ",") {
		if strings.TrimSpace(part) == want {
			return existing
		}
	}
	return existing + "," + want
}

// isClaudeAPIRequest 判断是否是注入给 Claude Code 的 Anthropic 路由请求。
func isClaudeAPIRequest(path string) bool {
	return path == "/v1/messages" || strings.HasPrefix(path, "/v1/messages/")
}

// isClaudeGenerationRequest 判断是否消耗模型额度(需换号池 token 并计量)。
// /v1/messages 是生成;/v1/messages/count_tokens 只算 token、不生成。
func isClaudeGenerationRequest(path string) bool {
	return path == "/v1/messages"
}

type claudeLeaseFunc func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*ClaudeTokenLease, error)
type claudeReportFunc func(card, deviceId string, details ReportDetails, upstreamProxy string, lease *ClaudeTokenLease)

type ClaudeProxy struct {
	totalRequests int64
	totalErrors   int64

	// 可注入(测试);为 nil 时回落到全局 ClaudeLeaser。
	leaseToken    claudeLeaseFunc
	reportUsage   claudeReportFunc
	reportProblem claudeReportFunc
}

var globalClaudeProxy = &ClaudeProxy{}

func GetClaudeProxy() *ClaudeProxy { return globalClaudeProxy }

func (p *ClaudeProxy) lease() claudeLeaseFunc {
	if p.leaseToken != nil {
		return p.leaseToken
	}
	return GetClaudeLeaser().LeaseToken
}

func (p *ClaudeProxy) doReportUsage(card, deviceId string, d ReportDetails, up string, lease *ClaudeTokenLease) {
	if p.reportUsage != nil {
		p.reportUsage(card, deviceId, d, up, lease)
		return
	}
	GetClaudeLeaser().ReportUsage(card, deviceId, d, up, lease)
}

func (p *ClaudeProxy) doReportProblem(card, deviceId string, d ReportDetails, up string, lease *ClaudeTokenLease) {
	if p.reportProblem != nil {
		p.reportProblem(card, deviceId, d, up, lease)
		return
	}
	GetClaudeLeaser().ReportProblem(card, deviceId, d, up, lease)
}

func (p *ClaudeProxy) ServeHTTP(w http.ResponseWriter, r *http.Request, card, deviceId, upstreamProxy string) {
	reqID := atomic.AddInt64(&p.totalRequests, 1)

	// 非生成的辅助请求(count_tokens 等)→ 注入 token 透传,不计量。
	if !isClaudeGenerationRequest(r.URL.Path) {
		p.forwardAux(w, r, card, deviceId, upstreamProxy, reqID)
		return
	}

	if r.Method != http.MethodPost {
		p.sendJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if card == "" {
		p.sendJSONError(w, http.StatusUnauthorized, "Claude account card is not configured")
		return
	}
	GetUsageStats().AddRequest()

	body, err := io.ReadAll(r.Body)
	if err != nil {
		p.sendJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	modelKey := extractClaudeModelKey(body)
	if modelKey == "" {
		modelKey = "claude-opus-4-20250514"
	}

	lease, err := p.lease()(card, deviceId, true, map[string]interface{}{
		"modelKey":  modelKey,
		"bodyBytes": len(body),
	}, upstreamProxy)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.sendJSONError(w, http.StatusBadGateway, fmt.Sprintf("Claude token lease failed: %v", err))
		return
	}
	Log("[claude-proxy] #%d [生成] %s model=%s → 用号池token accountId=%d", reqID, r.URL.Path, modelKey, lease.AccountId)

	targetURL := strings.TrimRight(ANTHROPIC_API_BASE, "/") + r.URL.Path
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build upstream request")
		return
	}
	applyClaudeUpstreamHeaders(req.Header, r.Header, lease.AccessToken, targetURL)

	// 出口层:utls 指纹 + 每号粘性代理。优先用服务端为该号下发的住宅代理(lease.ProxyURL),
	// 否则回落到用户自己配置的上游代理。
	egress := effectiveClaudeProxy(lease.ProxyURL, upstreamProxy)
	egressLabel := egress
	if egressLabel == "" {
		egressLabel = "direct(本机IP)"
	}
	client := newClaudeUpstreamClient(egress)
	// 观测点①:发起上游请求之前。卡在 Do(连不上/握手/等响应头)时,日志会停在这一行。
	Log("[claude-proxy] #%d [生成] → 请求上游 %s egress=%s", reqID, targetURL, egressLabel)
	resp, err := client.Do(req)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		// 观测点②a:Do 直接失败(连接/握手/响应头超时)——这里能看到真实错误文本。
		Log("[claude-proxy] #%d [生成] ✗ 上游请求失败(Do err):%v", reqID, err)
		p.doReportProblem(card, deviceId, ReportDetails{
			StatusCode: 502, ModelKey: modelKey, Reason: "upstream_error", ErrorText: err.Error(),
		}, upstreamProxy, lease)
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	// 观测点②b:已拿到响应头。能区分"卡在网络"还是"上游回了码但 body 不对"。
	Log("[claude-proxy] #%d [生成] ← 上游响应头 码=%d ct=%q ce=%q",
		reqID, resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("Content-Encoding"))
	// 探针:成功响应时把 anthropic 限流头打到日志,确认 5h/周额度的 unified 头真实名
	// (代码里没有、429 响应也不带,只能从真实 200 抓)。拿到头名后据此实现"解析→搭
	// reportResult 回服务端落库"的额度刷新,零额外请求。
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		for k, vs := range resp.Header {
			lk := strings.ToLower(k)
			if strings.Contains(lk, "ratelimit") || strings.HasPrefix(lk, "anthropic-") || lk == "retry-after" {
				Log("[claude-proxy] #%d [hdr-probe] %s: %s", reqID, k, strings.Join(vs, ","))
			}
		}
	}

	streamBack := resp.StatusCode >= 200 && resp.StatusCode < 300 &&
		(isClaudeStreamingResponse(resp) || requestWantsStream(body))
	if streamBack {
		writeUpstreamHeaders(w, resp)
		w.WriteHeader(resp.StatusCode)
		usage, copyErr := copyStreamingClaudeResponse(w, resp.Body)
		details := claudeReportDetailsFromUsage(resp.StatusCode, modelKey, usage)
		if copyErr != nil {
			details.StatusCode = 502
			details.Reason = "stream_copy_error"
			details.ErrorText = copyErr.Error()
			Log("[claude-proxy] #%d [生成] 上游码=%d 流中断:%v(不上报用量)", reqID, resp.StatusCode, copyErr)
			p.doReportProblem(card, deviceId, details, upstreamProxy, lease)
			// 头和 200 已发出,改不了状态码;补发一个 SSE error 事件,让 Claude Code 明确知道
			// 是上游中断而非正常结束(否则只看到流被截断、无错误提示)。
			msg, _ := json.Marshal("upstream stream interrupted: " + copyErr.Error())
			fmt.Fprintf(w, "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"upstream_stream_error\",\"message\":%s}}\n\n", msg)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return
		}
		Log("[claude-proxy] #%d [生成] ✓ 上游码=%d tokens(in=%d out=%d total=%d) → 已提交用量上报",
			reqID, resp.StatusCode, details.InputTokens, details.OutputTokens, details.RawTotalTokens)
		// 喂本地 dashboard 统计(今日输入/输出 Token);对齐 codex_proxy。漏了它 claude 的 token 永远显示 0。
		GetUsageStats().AddTokens(details.InputTokens, details.OutputTokens, details.CachedInputTokens)
		p.doReportUsage(card, deviceId, details, upstreamProxy, lease)
		return
	}

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.sendJSONError(w, http.StatusBadGateway, "failed to read Claude upstream response")
		return
	}
	writeUpstreamHeaders(w, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)

	details := claudeReportDetailsFromBody(resp.StatusCode, modelKey, respBody)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		Log("[claude-proxy] #%d [生成] ✓ 上游码=%d total=%d → 已提交用量上报", reqID, resp.StatusCode, details.RawTotalTokens)
		GetUsageStats().AddTokens(details.InputTokens, details.OutputTokens, details.CachedInputTokens)
		p.doReportUsage(card, deviceId, details, upstreamProxy, lease)
	} else {
		snippet := string(respBody)
		if len(snippet) > 400 {
			snippet = snippet[:400]
		}
		Log("[claude-proxy] #%d [生成] ✗ 上游码=%d acct=%d body=%q", reqID, resp.StatusCode, lease.AccountId, strings.TrimSpace(snippet))
		details.Reason = "claude_upstream_error"
		details.ErrorText = string(respBody)
		p.doReportProblem(card, deviceId, details, upstreamProxy, lease)
	}
}

// forwardAux 注入 token 后透传非生成的辅助请求(count_tokens 等),不计量。
func (p *ClaudeProxy) forwardAux(w http.ResponseWriter, r *http.Request, card, deviceId, upstreamProxy string, reqID int64) {
	body, _ := io.ReadAll(r.Body)
	if card == "" {
		p.sendJSONError(w, http.StatusUnauthorized, "Claude account card is not configured")
		return
	}
	lease, err := p.lease()(card, deviceId, false, nil, upstreamProxy)
	if err != nil {
		p.sendJSONError(w, http.StatusBadGateway, fmt.Sprintf("Claude token lease failed: %v", err))
		return
	}
	targetURL := strings.TrimRight(ANTHROPIC_API_BASE, "/") + r.URL.Path
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build upstream request")
		return
	}
	applyClaudeUpstreamHeaders(req.Header, r.Header, lease.AccessToken, targetURL)

	resp, err := newClaudeUpstreamClient(effectiveClaudeProxy(lease.ProxyURL, upstreamProxy)).Do(req)
	if err != nil {
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	writeUpstreamHeaders(w, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
	Log("[claude-proxy] #%d [辅助] %s 上游码=%d", reqID, r.URL.Path, resp.StatusCode)
}

// effectiveClaudeProxy 选出口代理:每号粘性住宅代理优先,否则用户配置的上游代理。
func effectiveClaudeProxy(accountProxy, userProxy string) string {
	if strings.TrimSpace(accountProxy) != "" {
		return strings.TrimSpace(accountProxy)
	}
	if up := strings.TrimSpace(userProxy); up != "" && !isDirectProxyMode(up) {
		return up
	}
	return ""
}

func isClaudeStreamingResponse(resp *http.Response) bool {
	return strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
}

// applyClaudeUpstreamHeaders 复用 Claude Code 自带的 anthropic-* / user-agent 头,
// 只把鉴权换成租来的 OAuth token(去掉 x-api-key,避免与 Bearer 冲突)。
func applyClaudeUpstreamHeaders(dst, src http.Header, accessToken, targetURL string) {
	skip := map[string]bool{
		"host": true, "authorization": true, "x-api-key": true,
		"content-length": true, "connection": true, "proxy-connection": true,
		"transfer-encoding": true, "accept-encoding": true,
	}
	for k, vs := range src {
		if skip[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
	dst.Set("Authorization", "Bearer "+accessToken)
	if dst.Get("Content-Type") == "" {
		dst.Set("Content-Type", "application/json")
	}
	if dst.Get("anthropic-version") == "" {
		dst.Set("anthropic-version", "2023-06-01")
	}
	// api.anthropic.com 只在带 anthropic-beta: oauth-2025-04-20 时才接受订阅号 OAuth
	// (sk-ant-oat…)token。自定义 base_url 模式下 Claude Code 可能不带,这里强制补齐
	// (合并保留已有的其它 beta flag),否则上游 401。值对照 Claude Code 2.x 实测常量。
	dst.Set("anthropic-beta", mergeAnthropicBeta(dst.Get("anthropic-beta"), claudeOAuthBeta))
	if u, err := url.Parse(targetURL); err == nil {
		dst.Set("Host", u.Host)
	}
}

func writeUpstreamHeaders(w http.ResponseWriter, resp *http.Response) {
	skip := map[string]bool{"content-length": true, "connection": true, "transfer-encoding": true}
	for k, vs := range resp.Header {
		if skip[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
}

func extractClaudeModelKey(body []byte) string {
	var payload struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	return payload.Model
}

// claudeReportDetailsFromUsage 由流式解析出的 usage 组装上报明细。
func claudeReportDetailsFromUsage(status int, modelKey string, u claudeUsage) ReportDetails {
	return ReportDetails{
		StatusCode:          status,
		ModelKey:            modelKey,
		InputTokens:         u.InputTokens,
		OutputTokens:        u.OutputTokens,
		CachedInputTokens:   u.CacheReadInputTokens,
		RawTotalTokens:      u.rawTotal(),
		BillableTotalTokens: u.rawTotal(),
	}
}

// claudeReportDetailsFromBody 解析非流式 JSON 响应体里的 usage。
func claudeReportDetailsFromBody(status int, modelKey string, body []byte) ReportDetails {
	var payload struct {
		Usage claudeSSEUsageShape `json:"usage"`
	}
	_ = json.Unmarshal(body, &payload)
	u := claudeUsage{
		InputTokens:              payload.Usage.InputTokens,
		OutputTokens:             payload.Usage.OutputTokens,
		CacheCreationInputTokens: payload.Usage.CacheCreationInputTokens,
		CacheReadInputTokens:     payload.Usage.CacheReadInputTokens,
	}
	return claudeReportDetailsFromUsage(status, modelKey, u)
}

func (p *ClaudeProxy) sendJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"type": "error",
		"error": map[string]interface{}{
			"type":    "claude_proxy_error",
			"message": message,
		},
	})
}
