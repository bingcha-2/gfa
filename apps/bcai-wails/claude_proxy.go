package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
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

// claudeDbg 控制"代理全量 trace"(请求/转发/响应 的头+体)。默认关,需要抓包时设
// BCAI_CLAUDE_DEBUG=1。OAuth token / cookie 一律打码。
var claudeDbg = getEnvOrDefault("BCAI_CLAUDE_DEBUG", "0") == "1"

// parseClaudeUnifiedWindows 从上游 anthropic-ratelimit-unified-* 响应头解析 5h/周额度。
// 头里是 *-Utilization(已用比例 0..1)+ *-Reset(epoch 秒);转成"剩余 %"+ISO reset。
// 仅成功(200)响应带这些头;解析到任一窗口即 ok=true。
func parseClaudeUnifiedWindows(h http.Header) (hourlyPct, weeklyPct float64, hourlyReset, weeklyReset string, ok bool) {
	remPct := func(key string) (float64, bool) {
		v := strings.TrimSpace(h.Get(key))
		if v == "" {
			return 0, false
		}
		util, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, false
		}
		rem := (1 - util) * 100 // Utilization=已用 → 剩余
		if rem < 0 {
			rem = 0
		} else if rem > 100 {
			rem = 100
		}
		return rem, true
	}
	resetISO := func(key string) string {
		v := strings.TrimSpace(h.Get(key))
		if v == "" {
			return ""
		}
		sec, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return ""
		}
		return time.Unix(sec, 0).UTC().Format(time.RFC3339)
	}
	if p, hok := remPct("Anthropic-Ratelimit-Unified-5h-Utilization"); hok {
		hourlyPct = p
		hourlyReset = resetISO("Anthropic-Ratelimit-Unified-5h-Reset")
		ok = true
	}
	if p, wok := remPct("Anthropic-Ratelimit-Unified-7d-Utilization"); wok {
		weeklyPct = p
		weeklyReset = resetISO("Anthropic-Ratelimit-Unified-7d-Reset")
		ok = true
	}
	return
}

// fillClaudeWindows 把解析到的窗口写进上报明细(无则不动)。
func fillClaudeWindows(d *ReportDetails, h http.Header) {
	hp, wp, hr, wr, ok := parseClaudeUnifiedWindows(h)
	if !ok {
		return
	}
	d.HasClaudeWindows = true
	d.ClaudeHourlyPercent = hp
	d.ClaudeWeeklyPercent = wp
	d.ClaudeHourlyResetTime = hr
	d.ClaudeWeeklyResetTime = wr
}

func maskClaudeSecret(s string) string {
	if len(s) <= 16 {
		return "***"
	}
	return s[:10] + "...(" + fmt.Sprintf("%d", len(s)) + "ch)..." + s[len(s)-4:]
}

// dumpClaudeHeaders 把一组头逐行打到日志(敏感头打码)。
func dumpClaudeHeaders(reqID int64, tag string, h http.Header) {
	if !claudeDbg {
		return
	}
	for k, vs := range h {
		val := strings.Join(vs, ",")
		switch strings.ToLower(k) {
		case "authorization", "x-api-key", "cookie", "set-cookie":
			val = maskClaudeSecret(val)
		}
		Log("[claude-proxy] #%d [%s] %s: %s", reqID, tag, k, val)
	}
}

// dumpClaudeBody 打印 body(截断到 4KB,避免刷屏)。
func dumpClaudeBody(reqID int64, tag string, b []byte) {
	if !claudeDbg {
		return
	}
	const capN = 4096
	s := string(b)
	if len(s) > capN {
		s = s[:capN] + fmt.Sprintf("...(+%d bytes)", len(b)-capN)
	}
	Log("[claude-proxy] #%d [%s] (%d bytes) %s", reqID, tag, len(b), s)
}

// capWriter 累积写入的前 max 字节(用于 tee 流式响应到日志)。
type capWriter struct {
	buf []byte
	max int
}

func (c *capWriter) Write(p []byte) (int, error) {
	if len(c.buf) < c.max {
		n := c.max - len(c.buf)
		if n > len(p) {
			n = len(p)
		}
		c.buf = append(c.buf, p[:n]...)
	}
	return len(p), nil
}

// teeFlushWriter 把写入同时复制到 cap,并把 Flush 透传给底层 ResponseWriter
// (保留 SSE 的逐块 flush,不破坏流式)。
type teeFlushWriter struct {
	w   http.ResponseWriter
	cap *capWriter
}

func (t *teeFlushWriter) Write(p []byte) (int, error) {
	t.cap.Write(p)
	return t.w.Write(p)
}

func (t *teeFlushWriter) Flush() {
	if f, ok := t.w.(http.Flusher); ok {
		f.Flush()
	}
}

// claudeAllowDirect:是否允许从本机 IP 直连 api.anthropic.com。默认【禁止】——出口必须走
// 号的粘性住宅代理(lease.ProxyURL)或用户上游代理,否则一堆号从同一 IP 直出会被风控。
// 仅本地调试可显式设 BCAI_CLAUDE_ALLOW_DIRECT=1 放行。
var claudeAllowDirect = getEnvOrDefault("BCAI_CLAUDE_ALLOW_DIRECT", "0") == "1"

// claudeEgressBlocked 当出口为空(直连本机)且未放行时返回 true,调用方据此拒绝请求。
func claudeEgressBlocked(egress string) bool {
	return strings.TrimSpace(egress) == "" && !claudeAllowDirect
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

	// ── 全量 trace:入站请求(Claude Code 发来的)──
	if claudeDbg {
		Log("[claude-proxy] #%d [req] %s %s", reqID, r.Method, r.URL.String())
		dumpClaudeHeaders(reqID, "req-hdr", r.Header)
		dumpClaudeBody(reqID, "req-body", body)
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
	// ── 全量 trace:转发给 anthropic 的请求头(Authorization 打码)──
	dumpClaudeHeaders(reqID, "upstream-req-hdr", req.Header)

	// 出口层:utls 指纹 + 每号粘性代理。优先用服务端为该号下发的住宅代理(lease.ProxyURL),
	// 否则回落到用户自己配置的上游代理。
	egress := claudeEgressProxy(lease.ProxyURL)
	// 安全闸:禁止从本机 IP 直连 anthropic。没有出口代理 → 拒绝,绝不泄露本机 IP。
	if claudeEgressBlocked(egress) {
		atomic.AddInt64(&p.totalErrors, 1)
		Log("[claude-proxy] #%d [生成] ✗ 拒绝直连本机:号 accountId=%d 未下发出口代理(proxyUrl)、且无上游代理", reqID, lease.AccountId)
		p.doReportProblem(card, deviceId, ReportDetails{
			StatusCode: 502, ModelKey: modelKey, Reason: "no_egress_proxy",
			ErrorText: "no egress proxy; refusing direct connection from local IP",
		}, upstreamProxy, lease)
		p.sendJSONError(w, http.StatusBadGateway, "出口代理未配置:已拒绝从本机直连 api.anthropic.com(给该号配粘性住宅代理 proxyUrl,或设客户端 upstreamProxy;仅本地调试可设 BCAI_CLAUDE_ALLOW_DIRECT=1)")
		return
	}
	egressLabel := egress
	if egressLabel == "" {
		egressLabel = "direct(本机IP·已放行)"
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
	// ── 全量 trace:上游响应的【所有】头(含 anthropic-ratelimit-unified-* 限流头,
	// 即 5h/周额度的真实来源)。不限状态码,200/429 都打。──
	dumpClaudeHeaders(reqID, "resp-hdr", resp.Header)

	streamBack := resp.StatusCode >= 200 && resp.StatusCode < 300 &&
		(isClaudeStreamingResponse(resp) || requestWantsStream(body))
	if streamBack {
		writeUpstreamHeaders(w, resp)
		w.WriteHeader(resp.StatusCode)
		// 全量 trace:把 SSE 同时 tee 到容量缓冲(保留 flush,不破坏流式),copy 后打日志。
		var sink io.Writer = w
		var sseCap *capWriter
		if claudeDbg {
			sseCap = &capWriter{max: 8192}
			sink = &teeFlushWriter{w: w, cap: sseCap}
		}
		usage, copyErr := copyStreamingClaudeResponse(sink, resp.Body)
		if claudeDbg && sseCap != nil {
			dumpClaudeBody(reqID, "resp-sse", sseCap.buf)
		}
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
		// 解析 5h/周额度窗口(从这次真实 200 响应头),随上报回服务端 → 血条。零额外请求。
		fillClaudeWindows(&details, resp.Header)
		Log("[claude-proxy] #%d [生成] ✓ 上游码=%d tokens(in=%d out=%d total=%d) 额度(5h剩%.0f%% 周剩%.0f%%) → 已提交用量上报",
			reqID, resp.StatusCode, details.InputTokens, details.OutputTokens, details.RawTotalTokens, details.ClaudeHourlyPercent, details.ClaudeWeeklyPercent)
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
	// 全量 trace:非流式响应体(JSON,含错误 body 等)。
	dumpClaudeBody(reqID, "resp-body", respBody)
	writeUpstreamHeaders(w, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)

	details := claudeReportDetailsFromBody(resp.StatusCode, modelKey, respBody)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		fillClaudeWindows(&details, resp.Header)
		Log("[claude-proxy] #%d [生成] ✓ 上游码=%d total=%d 额度(5h剩%.0f%% 周剩%.0f%%) → 已提交用量上报", reqID, resp.StatusCode, details.RawTotalTokens, details.ClaudeHourlyPercent, details.ClaudeWeeklyPercent)
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
	if claudeDbg {
		Log("[claude-proxy] #%d [辅助][req] %s %s", reqID, r.Method, r.URL.String())
		dumpClaudeHeaders(reqID, "aux-req-hdr", r.Header)
		dumpClaudeBody(reqID, "aux-req-body", body)
		dumpClaudeHeaders(reqID, "aux-upstream-req-hdr", req.Header)
	}

	auxEgress := claudeEgressProxy(lease.ProxyURL)
	// 安全闸:辅助请求同样禁止从本机 IP 直连 anthropic。
	if claudeEgressBlocked(auxEgress) {
		Log("[claude-proxy] #%d [辅助] ✗ 拒绝直连本机:未配出口代理", reqID)
		p.sendJSONError(w, http.StatusBadGateway, "出口代理未配置:已拒绝从本机直连 api.anthropic.com")
		return
	}
	resp, err := newClaudeUpstreamClient(auxEgress).Do(req)
	if err != nil {
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	dumpClaudeHeaders(reqID, "aux-resp-hdr", resp.Header)
	dumpClaudeBody(reqID, "aux-resp-body", respBody)
	writeUpstreamHeaders(w, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
	Log("[claude-proxy] #%d [辅助] %s 上游码=%d", reqID, r.URL.Path, resp.StatusCode)
}

// claudeEgressProxy 返回该号的出口代理 = 服务端为账号下发的粘性住宅代理(lease.ProxyURL)。
// claude 出口【只】由服务端按号控制,不再回落客户端 upstreamProxy;为空则被安全闸拒绝(不直连)。
func claudeEgressProxy(accountProxy string) string {
	return strings.TrimSpace(accountProxy)
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
