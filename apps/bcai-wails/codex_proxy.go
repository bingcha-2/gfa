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
)

const DefaultCodexEndpoint = "https://chatgpt.com"

// codexDebugUsage 打开后:流式解析不到 usage 的含 "usage" 行会打日志,用于对齐字段格式。
// 默认关闭,排查 usage 字段格式时再临时改 true。
var codexDebugUsage = false

// Codex 官方客户端身份头(值对照 cockpit DEFAULT_CODEX_*)。chatgpt.com 的
// /backend-api/codex 用它们校验请求来自合法 Codex 客户端,缺则 401。
const (
	codexDefaultUserAgent  = "codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9"
	codexDefaultOriginator = "codex_cli_rs"
)

// applyCodexOfficialHeaders 在转发生成请求前补齐 Codex 官方头(仅在下游未带时补)。
// dst 是发往上游的请求头,src 是 Codex 发来的原始头。
func applyCodexOfficialHeaders(dst, src http.Header) {
	if src.Get("User-Agent") == "" {
		dst.Set("User-Agent", codexDefaultUserAgent)
	}
	if src.Get("Originator") == "" {
		dst.Set("Originator", codexDefaultOriginator)
	}
	if src.Get("Accept") == "" {
		// responses 是 SSE 流式,默认按 event-stream(上游也接受 application/json)。
		dst.Set("Accept", "text/event-stream")
	}
	dst.Set("Connection", "Keep-Alive")
}

// CodexRelayConfig 配置"API 卡密 / 第三方中转"模式:不租号、不要 card,直接用本地
// 配置的 key 把生成请求转发到中转站。对照 cockpit 的 codex-api-key 路径:
// POST {BaseURL}/responses + Authorization: Bearer <APIKey>,且不发 Originator /
// ChatGPT-Account-Id 这些 ChatGPT 专属客户端头(中转站不认、反而可能出错)。
// 中转站必须讲 Codex 的 responses 协议(吃 responses body、回 SSE)。
type CodexRelayConfig struct {
	BaseURL  string            // 中转站基址,请求落在 {BaseURL}/responses 或 /chat/completions
	APIKey   string            // 中转卡密,作为 Authorization: Bearer 注入
	ModelMap map[string]string // 可选:客户端模型名 → 中转模型名;空则原样透传
	// Protocol 选择上游协议:""/"responses" 走 Codex responses 协议(透传,默认);
	// "chat" 走通用 OpenAI /chat/completions(在客户端做 responses⇆chat 双向转码,
	// 见 codex_openai_relay.go)。
	Protocol string
}

type CodexProxy struct {
	totalRequests  int64
	totalErrors    int64
	swallowedCount int64
	upstreamBase   string
	// relay 由 ApplyConfig(UI 协程)热更新、ServeHTTP(请求协程)读取,必须用
	// relayMu 保护。每条请求开头用 currentRelay() 取一次快照,后续全程用快照,
	// 避免 UI 中途换配置导致读到撕裂指针或前后不一致(go test -race 也会报)。
	relayMu       sync.RWMutex
	relay         *CodexRelayConfig // 非空且 BaseURL/APIKey 齐全时启用中转模式
	leaseToken    func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error)
	reportResult  func(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease)
	reportProblem func(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease)
}

// currentRelay 返回当前中转配置的快照(可能为 nil)。加读锁,供请求协程安全读取。
func (p *CodexProxy) currentRelay() *CodexRelayConfig {
	p.relayMu.RLock()
	defer p.relayMu.RUnlock()
	return p.relay
}

// relayActive 判断当前是否走中转模式(配置齐全)。
func (p *CodexProxy) relayActive() bool {
	r := p.currentRelay()
	return r != nil && strings.TrimSpace(r.BaseURL) != "" && strings.TrimSpace(r.APIKey) != ""
}

// relayConfigFromConfig 从用户配置构建中转配置:仅当 CodexMode=="relay"(大小写不敏感)
// 且 base/key 齐全时返回非空;否则返回 nil(→ 走原有号池/租号流程)。
func relayConfigFromConfig(cfg Config) *CodexRelayConfig {
	if !strings.EqualFold(strings.TrimSpace(cfg.CodexMode), "relay") {
		return nil
	}
	base := strings.TrimSpace(cfg.CodexRelayBase)
	key := strings.TrimSpace(cfg.CodexRelayKey)
	if base == "" || key == "" {
		return nil
	}
	return &CodexRelayConfig{BaseURL: base, APIKey: key, ModelMap: cfg.CodexModelMap, Protocol: cfg.CodexRelayProtocol}
}

// ApplyConfig 把用户配置应用到全局 Codex 代理(目前只切换中转模式)。热生效,
// 无需重启代理:换掉 relay 指针,下一条请求即用新配置(加写锁与读侧互斥)。
func (p *CodexProxy) ApplyConfig(cfg Config) {
	next := relayConfigFromConfig(cfg)
	p.relayMu.Lock()
	p.relay = next
	p.relayMu.Unlock()
}

var globalCodexProxy = &CodexProxy{}

func GetCodexProxy() *CodexProxy {
	return globalCodexProxy
}

func isCodexAPIRequest(path string) bool {
	// antigravity 模式:Codex 用 chatgpt_base_url 指向本地代理,实际请求落在
	// /backend-api/codex/* (如 /backend-api/codex/responses[/compact])。
	if strings.HasPrefix(path, "/backend-api/codex/") {
		return true
	}
	// 兼容旧的自定义 provider 模式路径(base_url=.../v1, wire_api=responses)。
	switch path {
	case "/v1/models", "/v1/responses", "/v1/responses/compact", "/v1/chat/completions":
		return true
	default:
		return false
	}
}

// isCodexGenerationRequest 判断是否是"生成"请求(消耗模型额度,需要换号池 token)。
// 只有 responses 系列是生成;其余(插件/连接器/遥测/usage/设备注册等)都是 Codex
// 自身的非生成后端交互,应带用户自己的 token 原样透传(antigravity 模式)。
func isCodexGenerationRequest(path string) bool {
	switch path {
	case "/v1/responses", "/v1/responses/compact", "/v1/chat/completions",
		"/backend-api/codex/responses", "/backend-api/codex/responses/compact":
		return true
	default:
		return false
	}
}

func (p *CodexProxy) ServeHTTP(w http.ResponseWriter, r *http.Request, card, deviceId, upstreamProxy string) {
	// WebSocket 升级:新版 Codex 桌面版的对话走 ws,交给 ws 中间人(换号池 token + 双向桥接)。
	if isCodexWebSocketUpgrade(r) {
		p.serveCodexWebSocket(w, r, card, deviceId, upstreamProxy)
		return
	}

	reqID := atomic.AddInt64(&p.totalRequests, 1)

	if r.URL.Path == "/v1/models" && r.Method == http.MethodGet {
		p.sendModels(w)
		return
	}

	// 分流:
	//   非生成请求(插件/连接器/遥测/usage/设备注册等)→ 直接吞掉,返回 200 空响应。
	//     这些是 Codex 的可选后端杂活,与聊天无关。实测把它们透传到 chatgpt.com 会
	//     404(路径在 /backend-api/codex/ 下不存在)或 403(Cloudflare 拦截非官方
	//     客户端的请求,返回 HTML 登录页),反而触发 Codex 死循环重试、卡住加载。
	//     吞掉 = 告诉 Codex"没有插件/连接器",让它安静进入可用状态。
	//   生成请求(responses)→ 换号池 token,计量额度。
	if !isCodexGenerationRequest(r.URL.Path) {
		p.swallowNonGeneration(w, r, reqID)
		return
	}

	if r.Method != http.MethodPost {
		p.sendJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	// 计入仪表盘统计(今日请求)。codex 与 antigravity 共用同一套 UsageStatsStore,
	// 这里在确认是生成请求(POST)后计一次,中转/号池两条路都覆盖。
	GetUsageStats().AddRequest()
	// 中转(API 卡密)模式:不租号、不要 card,直接用本地配置的 key 转发到中转站。
	// 取一次快照贯穿整条请求,避免中途 UI 改配置导致前后不一致。
	if relay := p.currentRelay(); relay != nil && strings.TrimSpace(relay.BaseURL) != "" && strings.TrimSpace(relay.APIKey) != "" {
		p.serveRelayGeneration(w, r, reqID, upstreamProxy, relay)
		return
	}
	if card == "" {
		p.sendJSONError(w, http.StatusUnauthorized, "Codex account card is not configured")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		p.sendJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	body = normalizeCodexRequestBody(r.URL.Path, body)
	modelKey := extractCodexModelKey(body)
	if modelKey == "" {
		modelKey = "gpt-5-codex"
	}

	leaseFunc := p.leaseToken
	if leaseFunc == nil {
		leaseFunc = GetCodexLeaser().LeaseToken
	}
	lease, err := leaseFunc(card, deviceId, true, map[string]interface{}{
		"modelKey":  modelKey,
		"bodyBytes": len(body),
	}, upstreamProxy)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.sendJSONError(w, http.StatusBadGateway, fmt.Sprintf("Codex token lease failed: %v", err))
		return
	}
	// 一眼看清:这是生成请求,已用【号池】token(非本地 token)替换转发。
	Log("[codex-proxy] #%d [生成] %s model=%s → 用号池token accountId=%d(已替换Codex本地token)",
		reqID, r.URL.Path, modelKey, lease.AccountId)

	targetURL, err := p.targetURL(r)
	if err != nil {
		p.sendJSONError(w, http.StatusNotFound, err.Error())
		return
	}
	req, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build upstream request")
		return
	}
	copyCodexHeaders(req.Header, r.Header)
	req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", mustParseURL(targetURL).Host)
	// 补 Codex 官方客户端身份头(对照 cockpit send_upstream_request)。
	// provider 模式下 Codex 以为在调第三方 API,不会带这些 ChatGPT 专属头,而
	// chatgpt.com 的 /backend-api/codex 会据此校验客户端合法性,缺了会 401。
	applyCodexOfficialHeaders(req.Header, r.Header)
	// account_id 必须与租来的 token 一致:从租来的 access_token(JWT)里解出真实
	// chatgpt_account_id 覆盖该头,保证 token 与 account 一致。
	accountIDForLog := extractChatGPTAccountId(lease.AccessToken)
	if accountIDForLog != "" {
		req.Header.Set("ChatGPT-Account-Id", accountIDForLog)
	} else {
		accountIDForLog = "(none)"
		req.Header.Del("ChatGPT-Account-Id")
	}

	// All proxied Codex endpoints (/v1/responses[/compact], /v1/chat/completions)
	// are generation endpoints, and the upstream may stream the response regardless
	// of the request "stream" flag. Whether we stream back is decided below from the
	// RESPONSE Content-Type — so gating the no-global-timeout client on the REQUEST
	// body is wrong: a streamed response whose request didn't set stream:true would
	// be read through the 120s client and any generation past 2 min gets truncated
	// mid-stream. Always use the streaming client (bounded by ResponseHeaderTimeout,
	// not a hard total timeout).
	client := createStreamingHttpClient(upstreamProxy)
	resp, err := client.Do(req)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.reportProblemSafe(card, deviceId, ReportDetails{
			StatusCode: 502,
			ModelKey:   modelKey,
			Reason:     "upstream_error",
			ErrorText:  err.Error(),
		}, upstreamProxy, lease)
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	_ = accountIDForLog

	// 何时按流式转发回 codex:上游对 responses 流式 200 有时**不带 Content-Type**
	// (实测 chatgpt.com 的 codex 后端回空 CT)。只靠响应头判流式会漏判 → 把整段 SSE
	// 当成单个 JSON 整体读,既丢了边转边发的流式体验,又因整段不是合法 JSON 解析不出
	// usage(tokens=0)。codex 的 responses 请求恒为流式,故改判据为:上游 2xx 且
	// (响应声明了 SSE 或请求要流式)。copyStreamingCodexResponse 对单行裸 JSON 也能解
	// usage,真·非流式 2xx 走到这里也不会误伤;非 2xx 仍落到下面的整体读分支(带错误体日志)。
	streamBack := resp.StatusCode >= 200 && resp.StatusCode < 300 &&
		(isCodexStreamingResponse(resp) || requestWantsStream(body))
	if streamBack {
		p.writeResponseHeaders(w, resp)
		w.WriteHeader(resp.StatusCode)
		input, output, total, copyErr := copyStreamingCodexResponse(w, resp.Body)
		details := ReportDetails{
			StatusCode:          resp.StatusCode,
			ModelKey:            modelKey,
			InputTokens:         input,
			OutputTokens:        output,
			RawTotalTokens:      total,
			BillableTotalTokens: total,
		}
		if copyErr != nil {
			details.StatusCode = 502
			details.Reason = "stream_copy_error"
			details.ErrorText = copyErr.Error()
			Log("[codex-proxy] #%d [生成] 上游码=%d 流中断:%v(不上报用量)", reqID, resp.StatusCode, copyErr)
			p.reportProblemSafe(card, deviceId, details, upstreamProxy, lease)
			return
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			Log("[codex-proxy] #%d [生成] ✓ 上游码=%d tokens(in=%d out=%d total=%d) → 已提交用量上报",
				reqID, resp.StatusCode, input, output, total)
			p.reportUsageSafe(card, deviceId, details, upstreamProxy, lease)
		} else {
			Log("[codex-proxy] #%d [生成] ✗ 上游码=%d(非2xx)→ 上报为问题,不计费", reqID, resp.StatusCode)
			details.Reason = "codex_upstream_error"
			p.reportProblemSafe(card, deviceId, details, upstreamProxy, lease)
		}
		return
	}

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.sendJSONError(w, http.StatusBadGateway, "failed to read Codex upstream response")
		return
	}

	p.writeResponseHeaders(w, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)

	details := codexReportDetails(resp.StatusCode, modelKey, respBody)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		Log("[codex-proxy] #%d [生成] ✓ 上游码=%d tokens=%d → 已提交用量上报",
			reqID, resp.StatusCode, details.BillableTotalTokens)
		p.reportUsageSafe(card, deviceId, details, upstreamProxy, lease)
	} else {
		snippet := string(respBody)
		if len(snippet) > 400 {
			snippet = snippet[:400]
		}
		Log("[codex-proxy] #%d [生成] ✗ 上游码=%d acct=%d body=%q", reqID, resp.StatusCode, lease.AccountId, strings.TrimSpace(snippet))
		details.Reason = "codex_upstream_error"
		details.ErrorText = string(respBody)
		p.reportProblemSafe(card, deviceId, details, upstreamProxy, lease)
	}
}

// serveRelayGeneration 处理中转模式的生成请求:用本地配置的卡密直连第三方中转站。
// 与号池模式的区别(对照 cockpit codex-api-key 路径):
//   - 不调 lease、不要 card、不上报用量(额度不管、与号池不关联);
//   - Authorization 用配置的中转 key,而非租来的 token;
//   - 目标是 {BaseURL}/responses,而非 chatgpt.com/backend-api/codex;
//   - 不发 Originator / ChatGPT-Account-Id 这些 ChatGPT 专属客户端头。
func (p *CodexProxy) serveRelayGeneration(w http.ResponseWriter, r *http.Request, reqID int64, upstreamProxy string, relay *CodexRelayConfig) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		p.sendJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	body = normalizeCodexRequestBody(r.URL.Path, body)
	modelKey := extractCodexModelKey(body)
	if modelKey == "" {
		modelKey = "gpt-5-codex"
	}
	mappedModel := mapRelayModel(relay, modelKey)
	chatMode := strings.EqualFold(strings.TrimSpace(relay.Protocol), "chat")
	stream := requestWantsStream(body)

	// 请求体 + 上游路径:chat 模式把 responses 请求转码成 chat/completions,否则
	// responses 透传(只按需改写 model 名)。
	var targetURL string
	if chatMode {
		body = convertResponsesToChatRequest(body, mappedModel, stream)
		targetURL = relayChatTargetURL(relay, r)
	} else {
		if mappedModel != modelKey {
			body = rewriteCodexModel(body, mappedModel)
		}
		targetURL = relayTargetURL(relay, r)
	}
	modelKey = mappedModel

	req, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build relay request")
		return
	}
	copyCodexHeaders(req.Header, r.Header)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(relay.APIKey))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", mustParseURL(targetURL).Host)
	applyCodexRelayHeaders(req.Header, r.Header)

	Log("[codex-proxy] #%d [中转] %s model=%s proto=%s → %s(本地卡密)",
		reqID, r.URL.Path, modelKey, relayProtoLabel(chatMode), targetURL)

	client := createStreamingHttpClient(upstreamProxy)
	resp, err := client.Do(req)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()

	// chat 模式:把上游 chat/completions 响应回译成 Codex responses 再返回 Codex。
	if chatMode {
		p.serveRelayChatResponse(w, resp, reqID, modelKey)
		return
	}

	// responses 模式:不计量额度,流式直接转发,非流式整体回写。两者都不上报用量。
	if isCodexStreamingResponse(resp) {
		p.writeResponseHeaders(w, resp)
		w.WriteHeader(resp.StatusCode)
		if _, _, _, copyErr := copyStreamingCodexResponse(w, resp.Body); copyErr != nil {
			Log("[codex-proxy] #%d [中转] 上游码=%d 流中断:%v", reqID, resp.StatusCode, copyErr)
		}
		return
	}

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.sendJSONError(w, http.StatusBadGateway, "failed to read relay upstream response")
		return
	}
	p.writeResponseHeaders(w, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		atomic.AddInt64(&p.totalErrors, 1)
		Log("[codex-proxy] #%d [中转] ✗ 上游码=%d", reqID, resp.StatusCode)
	}
}

// relayTargetURL 拼出中转目标地址:{BaseURL}/responses[/compact],保留查询串。
func relayTargetURL(relay *CodexRelayConfig, r *http.Request) string {
	base := strings.TrimSuffix(strings.TrimSpace(relay.BaseURL), "/")
	suffix := "/responses"
	if strings.HasSuffix(r.URL.Path, "/compact") {
		suffix = "/responses/compact"
	}
	target := base + suffix
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	return target
}

// relayChatTargetURL 拼出通用 OpenAI 中转的 chat 端点:{BaseURL}/chat/completions。
func relayChatTargetURL(relay *CodexRelayConfig, r *http.Request) string {
	base := strings.TrimSuffix(strings.TrimSpace(relay.BaseURL), "/")
	target := base + "/chat/completions"
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	return target
}

// serveRelayChatResponse 处理 chat 协议中转的上游响应:把 chat/completions 回译为
// Codex responses 格式后返回给 Codex。流式 → responses SSE;非流式 → responses JSON。
// 转码逻辑见 codex_openai_relay.go。
func (p *CodexProxy) serveRelayChatResponse(w http.ResponseWriter, resp *http.Response, reqID int64, model string) {
	created := relayNowUnix()
	if isCodexStreamingResponse(resp) {
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		if _, _, _, err := streamChatToResponses(w, resp.Body, model, created); err != nil {
			Log("[codex-proxy] #%d [中转/chat] 流中断:%v", reqID, err)
		}
		return
	}

	chatBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		p.sendJSONError(w, http.StatusBadGateway, "failed to read relay upstream response")
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 上游报错:打出错误体(截断)便于排查,并原样透传(不强行转码)。
		atomic.AddInt64(&p.totalErrors, 1)
		snippet := string(chatBody)
		if len(snippet) > 600 {
			snippet = snippet[:600]
		}
		Log("[codex-proxy] #%d [中转/chat] ✗ 上游码=%d body=%q", reqID, resp.StatusCode, strings.TrimSpace(snippet))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(chatBody)
		return
	}
	out := convertChatToResponsesJSON(chatBody, model, created)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func relayProtoLabel(chatMode bool) string {
	if chatMode {
		return "chat"
	}
	return "responses"
}

// requestWantsStream 读出请求体里的 stream 标志(默认 false)。
func requestWantsStream(body []byte) bool {
	var m map[string]interface{}
	if json.Unmarshal(body, &m) != nil {
		return false
	}
	s, _ := m["stream"].(bool)
	return s
}

// mapRelayModel 按配置把客户端模型名映射到中转模型名;无映射则原样返回。
func mapRelayModel(relay *CodexRelayConfig, model string) string {
	if relay == nil || len(relay.ModelMap) == 0 {
		return model
	}
	if mapped, ok := relay.ModelMap[model]; ok && strings.TrimSpace(mapped) != "" {
		return mapped
	}
	return model
}

// rewriteCodexModel 改写请求体里的 model 字段;解析失败则原样返回。
func rewriteCodexModel(body []byte, model string) []byte {
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	payload["model"] = model
	out, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return out
}

// applyCodexRelayHeaders 补中转模式需要的头(对照 cockpit 的 API 卡密路径):保留
// User-Agent(codex_cli_rs)+ Accept(SSE)+ Connection,但显式删掉 Originator 与
// ChatGPT-Account-Id —— 这些是 chatgpt.com 校验官方客户端用的,中转站不认。
func applyCodexRelayHeaders(dst, src http.Header) {
	if src.Get("User-Agent") == "" {
		dst.Set("User-Agent", codexDefaultUserAgent)
	}
	if src.Get("Accept") == "" {
		dst.Set("Accept", "text/event-stream")
	}
	dst.Set("Connection", "Keep-Alive")
	dst.Del("Originator")
	dst.Del("ChatGPT-Account-Id")
}

// swallowNonGeneration 吞掉非生成请求,本地返回一个无害的 200 空响应,不转发上游。
// 这些是 Codex 的可选后端杂活(插件/连接器/遥测/usage/设备注册等),与聊天无关;转发到
// chatgpt.com 会 404 或被 Cloudflare 403 拦,反而触发 Codex 死循环重试、卡住加载。
// 返回符合各端点形状的"空集"应答,让 Codex 认为"没有插件/连接器",安静进入可用状态。
func (p *CodexProxy) swallowNonGeneration(w http.ResponseWriter, r *http.Request, reqID int64) {
	// 丢弃请求体(避免连接半开)。
	if r.Body != nil {
		_, _ = io.Copy(io.Discard, r.Body)
	}
	body := emptyResponseForPath(r.URL.Path)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
	// 默认静默(这些杂活请求量极大,逐条打日志会刷屏淹没生成请求)。
	// 每累计 50 条吞掉的请求才汇总一行,便于确认"代理在工作但没打扰生成日志"。
	n := atomic.AddInt64(&p.swallowedCount, 1)
	if n%50 == 1 {
		Log("[codex-proxy] [杂活] 已静默吞掉 %d 条非生成请求(插件/遥测/注册等,与聊天无关)", n)
	}
}

// emptyResponseForPath 按端点形状返回合理的空 JSON,尽量贴近 Codex 期望的结构,
// 减少前端解析报错。未知端点回退到 {}。
func emptyResponseForPath(path string) string {
	switch {
	case strings.Contains(path, "/plugins/installed"),
		strings.Contains(path, "/plugins/list"),
		strings.Contains(path, "/plugins/featured"):
		return `{"items":[],"plugins":[]}`
	case strings.Contains(path, "/connectors/directory/list"):
		return `{"items":[],"connectors":[]}`
	case strings.Contains(path, "/wham/apps"):
		return `{"apps":[]}`
	default:
		return `{}`
	}
}

func (p *CodexProxy) writeResponseHeaders(w http.ResponseWriter, resp *http.Response) {
	for key, values := range resp.Header {
		if strings.EqualFold(key, "Content-Length") || isHopByHopHeader(key) {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
}

func (p *CodexProxy) targetURL(r *http.Request) (string, error) {
	base := p.upstreamBase
	if base == "" {
		base = DefaultCodexEndpoint
	}
	upstreamPath := ""
	switch {
	// antigravity 模式:/backend-api/codex/* 原样透传到 chatgpt.com 同路径。
	case strings.HasPrefix(r.URL.Path, "/backend-api/codex/"):
		upstreamPath = r.URL.Path
	// 兼容旧自定义 provider 模式:/v1/* 映射到 codex 后端路径。
	case r.URL.Path == "/v1/responses":
		upstreamPath = "/backend-api/codex/responses"
	case r.URL.Path == "/v1/responses/compact":
		upstreamPath = "/backend-api/codex/responses/compact"
	case r.URL.Path == "/v1/chat/completions":
		upstreamPath = "/backend-api/codex/responses"
	default:
		return "", fmt.Errorf("unsupported Codex path")
	}
	target, err := url.Parse(base + upstreamPath)
	if err != nil {
		return "", err
	}
	target.RawQuery = r.URL.RawQuery
	return target.String(), nil
}

func (p *CodexProxy) sendModels(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"object": "list",
		"data": []map[string]interface{}{
			{"id": "gpt-5-codex", "object": "model", "owned_by": "openai"},
			{"id": "gpt-5", "object": "model", "owned_by": "openai"},
			{"id": "codex-mini-latest", "object": "model", "owned_by": "openai"},
		},
	})
}

func (p *CodexProxy) sendJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]interface{}{
			"message": message,
			"type":    "codex_proxy_error",
		},
	})
}

func (p *CodexProxy) reportUsageSafe(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
	reportFunc := p.reportResult
	if reportFunc == nil {
		reportFunc = GetCodexLeaser().ReportUsage
	}
	reportFunc(card, deviceId, details, upstreamProxy, lease)
	// 把 codex 用量计入共享的本地额度(模型用量看板的 Codex 桶来源)。
	if details.BillableTotalTokens > 0 {
		GetLeaser().RecordLocalUsage(details.ModelKey, details.BillableTotalTokens)
	}
	// 再计入仪表盘统计(输入/输出 Token + 累计已节省)。与 antigravity 路径
	// (proxy_tokens.go)共用 UsageStatsStore;节省金额在 AddTokens 内按 in/out 价格算。
	GetUsageStats().AddTokens(details.InputTokens, details.OutputTokens, 0)
	GetUsageStats().AddGeneration()
}

func (p *CodexProxy) reportProblemSafe(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
	reportFunc := p.reportProblem
	if reportFunc == nil {
		reportFunc = GetCodexLeaser().ReportProblem
	}
	reportFunc(card, deviceId, details, upstreamProxy, lease)
	// 计入仪表盘错误数(codex 上游报错/流中断)。
	GetUsageStats().AddError()
}

func copyCodexHeaders(dst, src http.Header) {
	for key, values := range src {
		lower := strings.ToLower(key)
		if lower == "host" || lower == "authorization" || lower == "content-length" {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func normalizeCodexRequestBody(path string, body []byte) []byte {
	if path != "/v1/chat/completions" {
		return body
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	messages, ok := payload["messages"]
	if !ok {
		return body
	}
	payload["input"] = messages
	delete(payload, "messages")
	rewritten, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return rewritten
}

func isCodexStreamingResponse(resp *http.Response) bool {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(contentType, "text/event-stream")
}

// copyStreamingCodexResponse 边转发 SSE 边解析最终的 usage(input/output/total)。
// codex 流式响应的用量在 response.completed/response.done 事件的 response.usage 里,
// 之前只逐字节转发、不解析,导致流式用量上报为 0(完全不计费)。
func copyStreamingCodexResponse(w http.ResponseWriter, body io.Reader) (int64, int64, int64, error) {
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	var pending []byte
	var input, output, total int64

	scan := func(chunk []byte, flushTail bool) {
		pending = append(pending, chunk...)
		for {
			idx := bytes.IndexByte(pending, '\n')
			if idx < 0 {
				break
			}
			line := pending[:idx]
			if i, o, t, ok := codexUsageFromSSELine(line); ok {
				input, output, total = i, o, t
			} else if codexDebugUsage && bytes.Contains(line, []byte("usage")) {
				// 调试:解析不到但含 usage 的行,打出真实格式以便对齐字段路径。
				dbg := line
				if len(dbg) > 600 {
					dbg = dbg[:600]
				}
				Log("[codex-proxy][usage-dbg] 含usage但未解析: %s", string(bytes.TrimSpace(dbg)))
			}
			pending = pending[idx+1:]
		}
		if flushTail && len(pending) > 0 {
			if i, o, t, ok := codexUsageFromSSELine(pending); ok {
				input, output, total = i, o, t
			}
			pending = nil
		}
	}

	for {
		n, err := body.Read(buffer)
		if n > 0 {
			chunk := buffer[:n]
			if _, writeErr := w.Write(chunk); writeErr != nil {
				return input, output, total, writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
			scan(chunk, false)
		}
		if err == io.EOF {
			scan(nil, true)
			return input, output, total, nil
		}
		if err != nil {
			return input, output, total, err
		}
	}
}

// codexUsageFromSSELine 从一行 SSE(`data: {...}`)中解析 usage。
func codexUsageFromSSELine(line []byte) (int64, int64, int64, bool) {
	trimmed := bytes.TrimSpace(line)
	trimmed = bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return 0, 0, 0, false
	}
	return codexUsageFromJSON(trimmed)
}

func extractCodexModelKey(body []byte) string {
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	if model, ok := payload["model"].(string); ok {
		return model
	}
	return ""
}

func codexReportDetails(status int, modelKey string, body []byte) ReportDetails {
	input, output, total := extractCodexUsage(body)
	return ReportDetails{
		StatusCode:          status,
		ModelKey:            modelKey,
		InputTokens:         input,
		OutputTokens:        output,
		RawTotalTokens:      total,
		BillableTotalTokens: total,
	}
}

func extractCodexUsage(body []byte) (int64, int64, int64) {
	i, o, t, _ := codexUsageFromJSON(body)
	return i, o, t
}

// codexUsageFromJSON 从事件 JSON 中提取 usage,支持顶层 .usage 与 .response.usage
// (responses API 的 response.completed 事件把 usage 放在 response 下)。
func codexUsageFromJSON(data []byte) (int64, int64, int64, bool) {
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return 0, 0, 0, false
	}
	usage, _ := payload["usage"].(map[string]interface{})
	if usage == nil {
		if resp, ok := payload["response"].(map[string]interface{}); ok {
			usage, _ = resp["usage"].(map[string]interface{})
		}
	}
	if usage == nil {
		return 0, 0, 0, false
	}
	input := jsonNumberAsInt64(usage["input_tokens"])
	output := jsonNumberAsInt64(usage["output_tokens"])
	total := jsonNumberAsInt64(usage["total_tokens"])
	if total == 0 {
		total = input + output
	}
	if input == 0 && output == 0 && total == 0 {
		return 0, 0, 0, false
	}
	return input, output, total, true
}

func jsonNumberAsInt64(value interface{}) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int:
		return int64(v)
	case int64:
		return v
	case json.Number:
		n, _ := v.Int64()
		return n
	default:
		return 0
	}
}

func mustParseURL(raw string) *url.URL {
	parsed, err := url.Parse(raw)
	if err != nil {
		return &url.URL{}
	}
	return parsed
}
