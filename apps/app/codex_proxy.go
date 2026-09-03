package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ttftReader 包住上游响应体,记录第一个字节到达的时刻,用于算 TTFT(首字节时延)。
// 号池运营时 TTFT 能区分"是账号慢还是网络/上游慢",纯 token 计数看不出来。
type ttftReader struct {
	r           io.Reader
	start       time.Time
	firstByteAt time.Time
}

func (t *ttftReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 && t.firstByteAt.IsZero() {
		t.firstByteAt = time.Now()
	}
	return n, err
}

// ttftMs 返回首字节时延(毫秒);未读到任何字节时返回 -1。
func (t *ttftReader) ttftMs() int64 {
	if t.firstByteAt.IsZero() {
		return -1
	}
	return t.firstByteAt.Sub(t.start).Milliseconds()
}

const DefaultCodexEndpoint = "https://chatgpt.com"

// Relay routing and credentials are server-side implementation details. Keep
// customer-visible audit lines in the same shape as the ordinary Codex mother-
// account path while the actual request still uses the relay URL and API key.
const codexRelayAuditToken = "eyJhbGciOiJSUzI1NiJ9"

// codexDebugUsage 打开后:流式解析不到 usage 的含 "usage" 行会打日志,用于对齐字段格式。
// 默认关闭,排查 usage 字段格式时再临时改 true。
var codexDebugUsage = false

// Codex 官方客户端身份头(值对照 cockpit DEFAULT_CODEX_*)。chatgpt.com 的
// /backend-api/codex 用它们校验请求来自合法 Codex 客户端,缺则 401。
const (
	codexDefaultUserAgent       = "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)"
	codexDefaultOriginator      = "codex-tui"
	codexRelayDefaultUserAgent  = "bingcha-codex-relay/1.0"
)

// codexAttestationFailureEnvelope 是「app-server 尝试取设备证明但失败」的信封
// (README 状态码:2=request failed,无 t 字段)。桌面 app 发来的真 DeviceCheck token 被
// copyCodexHeaders 剥离后,池号路径用它回填 x-oai-attestation:模拟一台 DeviceCheck 失败的
// 真桌面。既不泄漏「订户设备 ↔ 池号」绑定(=池化铁证),又与我们外发的桌面身份自洽
// (比「桌面却完全不带证明」更像真实发生的状态)。无法为池号伪造 s:0 成功证明(Apple 硬件
// 签名不可伪造),失败信封是唯一既止血又自洽的形态。见 [[codex-attestation-egress-strip]]。
const codexAttestationFailureEnvelope = `{"v":1,"s":2}`

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
	// src 带过设备证明(桌面 app)→ 回填「失败」信封(真 token 已在 copyCodexHeaders 剥离)。
	// src 本就没证明(如内置 CLI)→ 不回填,保持该客户端「无证明」的原生形态。
	if src.Get("X-Oai-Attestation") != "" {
		dst.Set("X-Oai-Attestation", codexAttestationFailureEnvelope)
	}
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
	relayMu        sync.RWMutex
	relay          *CodexRelayConfig // 非空且 BaseURL/APIKey 齐全时启用中转模式
	fastMode       bool              // 用户「快速档」开关(codexFastMode);开+号支持时代理注入 service_tier=priority
	modelsMu       sync.Mutex
	modelsInFlight map[string]*codexModelsCall // 只合并正在进行的同 key 请求;完成即删除,不缓存目录
	leaseToken     func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error)
	reportResult   func(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease)
	reportProblem  func(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease)
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

// ensureCodexRentalMode 把配置强制切回「租号」模式并清掉所有中转(relay)残留,
// 然后热生效到全局代理。接管 Codex 时调用——接管即租号,不允许残留的中转配置把
// 生成请求劫持到外部中转站(见 codexTarget.Inject)。返回是否实际改动了配置
// (无中转残留时为 no-op,避免每次接管都重写 config.json)。
func ensureCodexRentalMode() (bool, error) {
	cfg := LoadConfig()
	// 已是纯租号且无任何中转残留 → 不动。
	if !strings.EqualFold(strings.TrimSpace(cfg.CodexMode), "relay") &&
		cfg.CodexRelayBase == "" && cfg.CodexRelayKey == "" &&
		cfg.CodexRelayProtocol == "" && len(cfg.CodexModelMap) == 0 {
		return false, nil
	}
	cfg.CodexMode = "rental"
	cfg.CodexRelayBase = ""
	cfg.CodexRelayKey = ""
	cfg.CodexRelayProtocol = ""
	cfg.CodexModelMap = nil
	if err := SaveConfig(cfg); err != nil {
		return false, err
	}
	GetCodexProxy().ApplyConfig(cfg) // 热生效:relay 指针置空,下一条请求即走号池
	return true, nil
}

// ApplyConfig 把用户配置应用到全局 Codex 代理(目前只切换中转模式)。热生效,
// 无需重启代理:换掉 relay 指针,下一条请求即用新配置(加写锁与读侧互斥)。
func (p *CodexProxy) ApplyConfig(cfg Config) {
	next := relayConfigFromConfig(cfg)
	p.relayMu.Lock()
	p.relay = next
	p.fastMode = cfg.CodexFastMode
	p.relayMu.Unlock()
}

// currentFastMode 返回「快速档」开关快照(加读锁,供请求协程安全读取)。
func (p *CodexProxy) currentFastMode() bool {
	p.relayMu.RLock()
	defer p.relayMu.RUnlock()
	return p.fastMode
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

func (p *CodexProxy) ServeHTTP(w http.ResponseWriter, r *http.Request, card, deviceId, upstreamProxy string, surface ...string) {
	// 接管面(codex 只有本地直连代理入口 → cli;无桌面 MITM)。
	surfaceTag := "cli"
	if len(surface) > 0 {
		surfaceTag = surface[0]
	}
	// 内置 openai provider 会先探测本机 /v1/responses WebSocket。明确返回 426,
	// 触发 Codex 官方的会话级 HTTP fallback,随后 POST 进入现有租号代理。
	if r.URL.Path == "/v1/responses" && isCodexWebSocketUpgrade(r) {
		w.WriteHeader(http.StatusUpgradeRequired)
		return
	}
	// 其他入口的 WebSocket 升级继续交给 ws 中间人(换号池 token + 双向桥接)。
	if isCodexWebSocketUpgrade(r) {
		p.serveCodexWebSocket(w, r, card, deviceId, upstreamProxy)
		return
	}

	reqID := atomic.AddInt64(&p.totalRequests, 1)

	if r.URL.Path == "/v1/models" && r.Method == http.MethodGet {
		p.serveModels(w, r, card, deviceId, upstreamProxy)
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
		// 绝不能回 401:codex 客户端收到 401 会触发 refresh-on-401,拿本地伪 refresh_token 去真
		// auth.openai.com 刷新 → 必失败 → 退回登录页(接管后"莫名要登录"的主因)。用 503 让它当作
		// 临时服务不可用(不重新登录、可稍后重试)。
		p.sendJSONError(w, http.StatusServiceUnavailable, "Codex account card is not configured")
		return
	}

	// 一次代理只出一条日志:全程累积到 audit,defer 时统一输出。
	audit := newProxyAudit("codex", reqID, "生成", r.Method, r.URL.Path)
	defer audit.emit()

	body, err := io.ReadAll(r.Body)
	if err != nil {
		audit.note = "读请求体失败:" + err.Error()
		p.sendJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	reportHeaders := filterReportHeaders(r.Header) // 过滤后的请求头(去凭证头、跳超大值)→ per-request 热表
	reportUserID := extractMetadataUserID(body)    // metadata.user_id → 服务端数真实用户
	body = normalizeCodexRequestBody(r.URL.Path, body)
	// 换号池 token 转发前剔除非法 reasoning.encrypted_content:上一个账号的签名对新
	// 账号无效,留着会让 chatgpt.com 直接报签名错误(换号场景的莫名 4xx 主因)。
	if cleaned, dropped := sanitizeCodexReasoningEncryptedContent(body); dropped > 0 {
		body = cleaned
	}
	audit.reqBody = body
	modelKey := extractCodexModelKey(body)
	if modelKey == "" {
		// 客户端漏发 model(实测切到部分新模型时 codex app 会不带 model 字段)。硬编码 gpt-5-codex
		// 会把归属/计费记到错模型。回落到 config.toml 里用户选定的模型,并写进请求体 —— 让上游按
		// 真实选择路由 + 上报一致。config 也没有(极少)才用 gpt-5-codex 兜底,保证不空。
		if cfgModel := codexConfiguredModel(); cfgModel != "" {
			modelKey = cfgModel
			body = rewriteCodexModel(body, cfgModel)
		} else {
			modelKey = "gpt-5-codex"
		}
	}
	audit.reqBody = body
	audit.model = modelKey

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
		audit.note = "lease 失败:" + err.Error()
		// 卡额度用完 → 标准 429 + Retry-After(让 IDE 退避/停),而非 502(会被当临时故障狂试)。
		if writeQuotaExhausted(w, err) {
			return
		}
		p.sendJSONError(w, http.StatusBadGateway, fmt.Sprintf("Codex token lease failed: %v", err))
		return
	}
	audit.accountID = lease.AccountId
	relayLease := lease.IsRelay()
	if relayLease {
		audit.token = codexRelayAuditToken
		audit.hideErrorBody = true
		mappedModel := mapRelayModel(&CodexRelayConfig{ModelMap: lease.Relay.ModelMap}, modelKey)
		if mappedModel != modelKey {
			body = rewriteCodexModel(body, mappedModel)
			modelKey = mappedModel
			audit.model = mappedModel
		}
	} else {
		audit.token = lease.AccessToken
	}
	if !relayLease && lease.AccountId > 0 {
		body = rewriteMetadataUserID(body, canonicalUserID(lease.AccountId), "")
	}
	// 快速档(Fast):用户点了 priority 且**被租号 plan 支持**才放行,否则剥回标准档(上游对不
	// 支持的号会忽略/报错)。只看租约带回的真实号 plan,不依赖未部署的服务端授权字段。
	// effServiceTier 取门控后的真实档位,供计量按 priority 加权。
	fastWanted := p.currentFastMode()
	incomingTier := codexRequestServiceTier(body)
	body = applyCodexServiceTier(body, fastWanted, lease.PlanType)
	audit.reqBody = body
	effServiceTier := codexRequestServiceTier(body)
	audit.serviceTier = effServiceTier
	// 决策诊断:一眼看清"快速档开关 / Codex 原发档 / 被租号 plan / 最终发上游什么"。
	Log("[codex-proxy][fast] 决策: 快速档=%v 客户端发档=%q 被租号plan=%q 最终发上游=%q", fastWanted, incomingTier, lease.PlanType, effServiceTier)

	var targetURL string
	if relayLease {
		targetURL = relayTargetURL(&CodexRelayConfig{BaseURL: lease.Relay.BaseURL}, r)
	} else {
		targetURL, err = p.targetURL(r)
	}
	if err != nil {
		audit.note = "目标地址错误:" + err.Error()
		p.sendJSONError(w, http.StatusNotFound, err.Error())
		return
	}
	audit.target = targetURL
	if relayLease {
		audit.target = codexRelayAuditTarget(r)
	}
	req, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build upstream request")
		return
	}
	copyCodexHeaders(req.Header, r.Header)
	credential := lease.AccessToken
	if relayLease {
		credential = lease.Relay.APIKey
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", mustParseURL(targetURL).Host)
	// 补 Codex 官方客户端身份头(对照 cockpit send_upstream_request)。
	// provider 模式下 Codex 以为在调第三方 API,不会带这些 ChatGPT 专属头,而
	// chatgpt.com 的 /backend-api/codex 会据此校验客户端合法性,缺了会 401。
	if relayLease {
		applyCodexRelayHeaders(req.Header, r.Header)
	} else {
		applyCodexOfficialHeaders(req.Header, r.Header)
	}
	// account_id 必须与租来的 token 一致:从租来的 access_token(JWT)里解出真实
	// chatgpt_account_id 覆盖该头,保证 token 与 account 一致。
	accountIDForLog := "(none)"
	if !relayLease {
		accountIDForLog = extractChatGPTAccountId(lease.AccessToken)
	}
	if !relayLease && accountIDForLog != "" {
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
	// 发往 chatgpt.com 走 uTLS(Chrome 指纹)绕过 Cloudflare TLS 指纹拦截;
	// fallback 内部对非受保护域名自动回退到标准 transport。
	// 出口:优先走所租账号绑定的住宅代理(egress);没绑定就本地直连(用户代理→系统→直连)。
	// codex 为 optional:绑定代理传输失败时降级本地直连重试一次,再不行才落到下面切号上报。
	reqStart := time.Now()
	var resp *http.Response
	if relayLease {
		// Relay data plane must leave the user's machine directly. Passing the
		// explicit direct sentinel bypasses both the configured upstream proxy
		// and the detected system proxy (Clash/Mihomo, etc.).
		resp, err = createCodexStreamingHttpClient("direct").Do(req)
	} else {
		resp, err = doUpstreamWithFallback(lease.EgressInfo, upstreamProxy, body, req, createCodexStreamingHttpClient)
	}
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.status = 502
		if relayLease {
			audit.note = "服务暂时不可用"
		} else {
			audit.note = "上游请求失败(Do err):" + err.Error()
		}
		p.reportProblemSafe(card, deviceId, ReportDetails{
			StatusCode: 502,
			ModelKey:   modelKey,
			Reason:     "upstream_error",
			ErrorText:  err.Error(),
		}, upstreamProxy, lease)
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	// A bound Codex USD subscription may borrow another same-level mother
	// account, but only after a fresh upstream usage check proves that the
	// weekly window (not merely a transient 429 or the retired 5h window) is
	// exhausted. The old signed lease is sent back so the server can validate
	// subscription/account/model attribution before selecting a fallback.
	if !relayLease && resp.StatusCode == http.StatusTooManyRequests && lease.AllowBoundOverflow {
		quotaEgress, _ := resolveEgress(lease.EgressInfo, upstreamProxy)
		if GetCodexLeaser().ConfirmWeeklyExhausted(card, quotaEgress, lease) {
			failedBody, _ := io.ReadAll(resp.Body)
			overflowOptions := map[string]interface{}{
				"modelKey":               modelKey,
				"bodyBytes":              len(body),
				"excludeAccountIds":      []int{lease.AccountId},
				"overflowFromLeaseId":    lease.LeaseId,
				"overflowFromLeaseProof": lease.LeaseProof,
				"overflowReason":         "quota_exhausted",
			}
			overflowLease, leaseErr := leaseFunc(card, deviceId, true, overflowOptions, upstreamProxy)
			if leaseErr == nil && overflowLease != nil && overflowLease.AccountId > 0 &&
				overflowLease.AccountId != lease.AccountId && !overflowLease.IsRelay() {
				failedDetails := codexReportDetails(resp.StatusCode, modelKey, failedBody)
				failedDetails.Reason = "quota_exhausted"
				failedDetails.ErrorText = string(failedBody)
				failedDetails.RequestStartedAt = reqStart.UnixMilli()
				failedDetails.UpstreamCompletedAt = time.Now().UnixMilli()
				failedDetails.ServiceTier = effServiceTier
				failedDetails.Surface = surfaceTag
				failedDetails.Headers = reportHeaders
				failedDetails.UserId = reportUserID
				p.reportProblemSafe(card, deviceId, failedDetails, upstreamProxy, lease)
				_ = resp.Body.Close()

				lease = overflowLease
				audit.accountID = lease.AccountId
				audit.token = lease.AccessToken
				body = rewriteMetadataUserID(body, canonicalUserID(lease.AccountId), "")
				body = applyCodexServiceTier(body, fastWanted, lease.PlanType)
				audit.reqBody = body
				effServiceTier = codexRequestServiceTier(body)
				audit.serviceTier = effServiceTier

				req, err = http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
				if err == nil {
					copyCodexHeaders(req.Header, r.Header)
					req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Host", mustParseURL(targetURL).Host)
					applyCodexOfficialHeaders(req.Header, r.Header)
					accountIDForLog = extractChatGPTAccountId(lease.AccessToken)
					if accountIDForLog != "" {
						req.Header.Set("ChatGPT-Account-Id", accountIDForLog)
					} else {
						accountIDForLog = "(none)"
						req.Header.Del("ChatGPT-Account-Id")
					}
					reqStart = time.Now()
					resp, err = doUpstreamWithFallback(
						lease.EgressInfo,
						upstreamProxy,
						body,
						req,
						createCodexStreamingHttpClient,
					)
				}
				if err != nil {
					atomic.AddInt64(&p.totalErrors, 1)
					audit.status = http.StatusBadGateway
					audit.note = "Codex overflow upstream request failed: " + err.Error()
					p.reportProblemSafe(card, deviceId, ReportDetails{
						StatusCode: http.StatusBadGateway,
						ModelKey:   modelKey,
						Reason:     "upstream_error",
						ErrorText:  err.Error(),
					}, upstreamProxy, lease)
					p.sendJSONError(w, http.StatusBadGateway, err.Error())
					return
				}
			} else {
				resp.Body = io.NopCloser(bytes.NewReader(failedBody))
			}
		}
	}
	defer resp.Body.Close()
	_ = accountIDForLog
	audit.status = resp.StatusCode

	// 何时按流式读取(解析 usage + 边转边发):这个 handler 只处理生成端点(/v1/responses[/compact]),
	// codex 的 responses 响应**恒为 SSE 流**。但上游有时不带 Content-Type、请求体也未必带 stream:true
	// (实测 model 为空的请求两个信号全无 → 空 CT + 无 stream),只靠这两个启发式会漏判,把整段 SSE
	// 当单个 JSON 整体 Unmarshal → 解析不出 usage(tokens=0、计费全丢,实测 25045 token 被记 0)。
	// 故直接以状态码为准:2xx 一律走流式读。copyStreamingCodexResponse 对单行裸 JSON 也能解 usage,
	// 真·非流式 2xx 走到这里也不会误伤;非 2xx 仍落到下面的整体读分支(带错误体日志)。
	streamBack := resp.StatusCode >= 200 && resp.StatusCode < 300
	if streamBack {
		// 上游可能按客户端透传上去的 Accept-Encoding 回**压缩的 SSE**(真 codex_cli_rs/reqwest
		// 默认带 gzip;copyCodexHeaders 未剥离 Accept-Encoding)。不解压就边转边发,我们扫描的是
		// 压缩字节,永远解析不到 usage → tokens=0、计费全丢(正是"请求数有、token 全 0"的根因)。
		// 就地解压成明文再转发:本地客户端(reqwest)一律能收明文,我们也才能解析 usage。
		streamBody := decodeCodexResponseStream(resp)
		p.writeResponseHeaders(w, resp)
		w.WriteHeader(resp.StatusCode)
		tee := newAuditTee(w)
		tr := &ttftReader{r: streamBody, start: reqStart}
		actualModel, input, output, cached, total, copyErr := copyStreamingCodexResponse(tee, tr)
		// 计费归属以**上游响应实际使用的模型**为准(权威),覆盖请求/config 的猜测:
		// 客户端漏发 model 时尤其重要 —— 否则会记到默认/猜的模型上,金额与用量都算错。
		if actualModel != "" {
			modelKey = actualModel
			audit.model = actualModel
		}
		// 计费护栏:2xx 生成却一个 token 都没解析到 = 用量丢失(历史上因流式漏判 / 未解压 / 字段
		// 路径变更多次踩到,静默丢计费)。留一条告警,回归时立刻可见。开 codexDebugUsage
		// 可进一步打出未匹配的原始 usage 行定位。
		if copyErr == nil && input == 0 && output == 0 {
			Log("[codex-proxy] ⚠ 2xx 生成但 usage 解析为 0(model=%s),可能计费丢失", modelKey)
		}
		details := codexDetailsFrom(resp.StatusCode, modelKey, input, output, cached, total)
		details.RequestStartedAt = reqStart.UnixMilli()
		details.UpstreamCompletedAt = time.Now().UnixMilli()
		details.ServiceTier = effServiceTier
		details.Surface = surfaceTag
		details.Headers = reportHeaders
		details.UserId = reportUserID
		audit.inTokens, audit.outTokens = input, output
		if copyErr != nil {
			details.StatusCode = 502
			details.Reason = "stream_copy_error"
			details.ErrorText = copyErr.Error()
			audit.note = "流中断(已上报已解析用量):" + copyErr.Error()
			p.reportProblemSafe(card, deviceId, details, upstreamProxy, lease)
			return
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			p.reportUsageSafe(card, deviceId, details, upstreamProxy, lease)
		} else {
			audit.note = "上游非2xx → 上报为问题,不计费"
			details.Reason = "codex_upstream_error"
			p.reportProblemSafe(card, deviceId, details, upstreamProxy, lease)
		}
		return
	}

	// 走到这里的只剩非 2xx(2xx 一律走上面的流式分支)。仍按 Content-Encoding 解压,便于错误体日志可读。
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "读上游响应失败:" + readErr.Error()
		p.sendJSONError(w, http.StatusBadGateway, "failed to read Codex upstream response")
		return
	}
	if enc := resp.Header.Get("Content-Encoding"); enc != "" {
		if decoded, ok := decodeUpstreamBytes(enc, respBody); ok {
			respBody = decoded
			resp.Header.Del("Content-Encoding")
		}
	}
	audit.respBody = respBody

	p.writeResponseHeaders(w, resp)
	// 上游 401 不能原样回给 codex 客户端:会触发 refresh-on-401 → 伪 refresh_token 刷新失败 →
	// 退回登录页。remap 成 502(普通网关错误,客户端可重试、不重新登录);问题上报仍用真实状态码。
	w.WriteHeader(clientFacingCodexStatus(resp.StatusCode))
	_, _ = w.Write(respBody)

	details := codexReportDetails(resp.StatusCode, modelKey, respBody)
	details.RequestStartedAt = reqStart.UnixMilli()
	details.UpstreamCompletedAt = time.Now().UnixMilli()
	details.ServiceTier = effServiceTier
	details.Surface = surfaceTag
	details.Headers = reportHeaders
	details.UserId = reportUserID
	audit.inTokens, audit.outTokens = details.InputTokens, details.OutputTokens
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		p.reportUsageSafe(card, deviceId, details, upstreamProxy, lease)
	} else {
		if relayLease {
			audit.note = "服务暂时不可用"
		} else {
			audit.note = "上游错误"
		}
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
	audit := newProxyAudit("codex", reqID, "生成", r.Method, r.URL.Path)
	defer audit.emit()
	audit.accountID = 900000001
	audit.hideErrorBody = true

	body, err := io.ReadAll(r.Body)
	if err != nil {
		audit.note = "读请求体失败:" + err.Error()
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
	audit.model = modelKey
	audit.target = codexRelayAuditTarget(r)
	audit.reqBody = body

	req, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		audit.note = "构造中转请求失败"
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build relay request")
		return
	}
	copyCodexHeaders(req.Header, r.Header)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(relay.APIKey))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", mustParseURL(targetURL).Host)
	applyCodexRelayHeaders(req.Header, r.Header)
	audit.token = codexRelayAuditToken

	// 中转目标多为第三方域名,会自动回退到标准 transport;仅当中转指向 chatgpt.com
	// 才会命中 uTLS(用同一入口便于统一维护)。
	// Local relay mode follows the same data-plane rule as a server-issued
	// relay lease: connect directly and ignore all local/system proxy settings.
	client := createCodexStreamingHttpClient("direct")
	resp, err := client.Do(req)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "服务暂时不可用"
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode

	// chat 模式:把上游 chat/completions 响应回译成 Codex responses 再返回 Codex。
	if chatMode {
		p.serveRelayChatResponse(w, resp, audit, modelKey)
		return
	}

	// responses 模式:不计量额度,流式直接转发,非流式整体回写。两者都不上报用量。
	if isCodexStreamingResponse(resp) {
		p.writeResponseHeaders(w, resp)
		w.WriteHeader(resp.StatusCode)
		tee := newAuditTee(w)
		if _, _, _, _, _, copyErr := copyStreamingCodexResponse(tee, resp.Body); copyErr != nil {
			audit.note = "流中断:" + copyErr.Error()
		}
		audit.respBody = tee.captured()
		return
	}

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "读中转响应失败:" + readErr.Error()
		p.sendJSONError(w, http.StatusBadGateway, "failed to read relay upstream response")
		return
	}
	audit.respBody = respBody
	p.writeResponseHeaders(w, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "服务暂时不可用"
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

// codexRelayAuditTarget returns only the customer-visible official Codex
// endpoint. It must never be used to build the actual upstream request.
func codexRelayAuditTarget(r *http.Request) string {
	path := "/backend-api/codex/responses"
	if strings.HasSuffix(r.URL.Path, "/compact") {
		path += "/compact"
	}
	target := DefaultCodexEndpoint + path
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
func (p *CodexProxy) serveRelayChatResponse(w http.ResponseWriter, resp *http.Response, audit *proxyAudit, model string) {
	created := relayNowUnix()
	if isCodexStreamingResponse(resp) {
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		tee := newAuditTee(w)
		if _, _, _, err := streamChatToResponses(tee, resp.Body, model, created); err != nil {
			audit.note = "chat 流中断:" + err.Error()
		}
		audit.respBody = tee.captured()
		return
	}

	chatBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "读中转响应失败:" + readErr.Error()
		p.sendJSONError(w, http.StatusBadGateway, "failed to read relay upstream response")
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 上游报错:原样透传(不强行转码),错误体进审计正文。
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "服务暂时不可用"
		audit.respBody = chatBody
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(chatBody)
		return
	}
	out := convertChatToResponsesJSON(chatBody, model, created)
	audit.respBody = out
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
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

// applyCodexRelayHeaders 补中转模式需要的头(对照 cockpit 的 API 卡密路径)。
// 第三方中转请求强制使用稳定的 Bingcha UA,避免把 OpenAI SDK/Codex 的
// SDK 专属 UA 带到 Cloudflare/WAF 后的中转站;同时显式删掉 Originator 与
// ChatGPT-Account-Id —— 这些是 chatgpt.com 校验官方客户端用的,中转站不认。
func applyCodexRelayHeaders(dst, src http.Header) {
	dst.Set("User-Agent", codexRelayDefaultUserAgent)
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

const (
	codexModelsMaxBytes = 4 << 20
	// 官方 models 目录经账号 egress 代理拉取:请求走 gzip(见 fetchCodexModels)把 ~277KB
	// 明文压到 ~40KB,读取不再顶满死线。10s 覆盖 egress connect + TLS 握手 + round-trip 余量;
	// 因 gzip 后成功已是常态,这个上限极少触发回退,不会明显阻塞 Codex app 取目录。
	// (旧值 4s 只够直连,经代理读整包明文必超时 → "官方目录获取失败" 刷屏。)
	codexModelsTimeout = 10 * time.Second
)

type codexModelsResult struct {
	body []byte
	etag string
	err  error
}

type codexModelsCall struct {
	done   chan struct{}
	result codexModelsResult
}

func (p *CodexProxy) serveModels(w http.ResponseWriter, r *http.Request, card, deviceID, upstreamProxy string) {
	result := p.fetchCodexModelsCoalesced(r, card, deviceID, upstreamProxy)
	if result.err == nil {
		writeCodexModelsResponse(w, result.body, result.etag)
		return
	}
	Log("[codex-models] 官方目录获取失败,使用本机缓存: %v", result.err)
	if body, etag, err := readCodexModelsCache(); err == nil {
		writeCodexModelsResponse(w, body, etag)
		return
	}
	writeCodexModelsResponse(w, []byte(`{"models":[]}`), "")
}

func (p *CodexProxy) fetchCodexModelsCoalesced(r *http.Request, card, deviceID, upstreamProxy string) codexModelsResult {
	key := card + "\x00" + r.URL.RawQuery
	p.modelsMu.Lock()
	if p.modelsInFlight == nil {
		p.modelsInFlight = make(map[string]*codexModelsCall)
	}
	if call := p.modelsInFlight[key]; call != nil {
		p.modelsMu.Unlock()
		select {
		case <-call.done:
			return cloneCodexModelsResult(call.result)
		case <-r.Context().Done():
			return codexModelsResult{err: r.Context().Err()}
		}
	}
	call := &codexModelsCall{done: make(chan struct{})}
	p.modelsInFlight[key] = call
	p.modelsMu.Unlock()

	result := p.fetchCodexModels(r, card, deviceID, upstreamProxy)
	p.modelsMu.Lock()
	call.result = cloneCodexModelsResult(result)
	delete(p.modelsInFlight, key)
	close(call.done)
	p.modelsMu.Unlock()
	return result
}

func cloneCodexModelsResult(result codexModelsResult) codexModelsResult {
	result.body = bytes.Clone(result.body)
	return result
}

func (p *CodexProxy) fetchCodexModels(r *http.Request, card, deviceID, upstreamProxy string) codexModelsResult {
	if strings.TrimSpace(card) == "" {
		return codexModelsResult{err: fmt.Errorf("Codex account card is not configured")}
	}
	leaseFunc := p.leaseToken
	if leaseFunc == nil {
		leaseFunc = GetCodexLeaser().LeaseToken
	}
	lease, err := leaseFunc(card, deviceID, false, nil, upstreamProxy)
	if err != nil {
		return codexModelsResult{err: fmt.Errorf("lease Codex token: %w", err)}
	}
	if lease.IsRelay() {
		body, marshalErr := codexRelayModelsBody(lease.Relay.Models)
		if marshalErr != nil {
			return codexModelsResult{err: fmt.Errorf("build relay models: %w", marshalErr)}
		}
		return codexModelsResult{body: body}
	}

	base := p.upstreamBase
	if base == "" {
		base = DefaultCodexEndpoint
	}
	target, err := url.Parse(strings.TrimRight(base, "/") + "/backend-api/codex/models")
	if err != nil {
		return codexModelsResult{err: fmt.Errorf("build models URL: %w", err)}
	}
	target.RawQuery = r.URL.RawQuery
	// 请求可能被多个下游调用者共享;不能让首个调用者断开时取消所有等待者。
	// 独立的 4s 上限仍保证后台请求不会失控悬挂。
	ctx, cancel := context.WithTimeout(context.Background(), codexModelsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return codexModelsResult{err: fmt.Errorf("build models request: %w", err)}
	}
	// 模型目录只转发官方识别客户端所需的身份头,不把 Cookie、代理凭据等
	// 下游本机凭据带到 chatgpt.com。
	for _, key := range []string{"User-Agent", "Originator"} {
		if value := r.Header.Get(key); value != "" {
			req.Header.Set(key, value)
		}
	}
	req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
	if accountID := extractChatGPTAccountId(lease.AccessToken); accountID != "" {
		req.Header.Set("ChatGPT-Account-Id", accountID)
	} else {
		req.Header.Del("ChatGPT-Account-Id")
	}
	applyCodexOfficialHeaders(req.Header, r.Header)
	req.Header.Set("Accept", "application/json")
	// 请求 gzip:目录明文 ~277KB,经 egress 代理读整包在 4s 内常超时。压到 ~40KB 后读取秒回。
	// 自定义 uTLS 传输不做 Go 的自动透明解压,故 readCodexModelsBody 按 Content-Encoding 手动还原。
	req.Header.Set("Accept-Encoding", "gzip")

	resp, err := doUpstreamWithFallback(lease.EgressInfo, upstreamProxy, nil, req, createCodexStreamingHttpClient)
	if err != nil {
		return codexModelsResult{err: fmt.Errorf("request official models: %w", err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return codexModelsResult{err: fmt.Errorf("official models status %d", resp.StatusCode)}
	}
	body, err := readCodexModelsBody(resp)
	if err != nil {
		return codexModelsResult{err: err}
	}
	return codexModelsResult{body: body, etag: resp.Header.Get("ETag")}
}

func codexRelayModelsBody(models []string) ([]byte, error) {
	type item struct {
		Slug        string `json:"slug"`
		DisplayName string `json:"display_name"`
	}
	items := make([]item, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, raw := range models {
		model := strings.TrimSpace(raw)
		if model == "" {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		items = append(items, item{Slug: model, DisplayName: model})
	}
	return json.Marshal(map[string]interface{}{"models": items})
}

// readCodexModelsBody 读取官方 models 响应体:限长 → 按 Content-Encoding 解压 → 校验 payload。
// 抽出以便对 gzip 解压路径单测(fetchCodexModels 其余部分依赖真实网络/租号,不易测)。
// 4MB 上限同时作用于压缩字节与解压结果,防超大/膨胀响应。
func readCodexModelsBody(resp *http.Response) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(resp.Body, codexModelsMaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read official models: %w", err)
	}
	if len(raw) > codexModelsMaxBytes {
		return nil, fmt.Errorf("official models response exceeds %d bytes", codexModelsMaxBytes)
	}
	body := raw
	if enc := resp.Header.Get("Content-Encoding"); enc != "" {
		decoded, ok := decodeUpstreamBytes(enc, raw)
		if !ok {
			return nil, fmt.Errorf("decode official models (%s)", enc)
		}
		if len(decoded) > codexModelsMaxBytes {
			return nil, fmt.Errorf("official models decoded exceeds %d bytes", codexModelsMaxBytes)
		}
		body = decoded
	}
	if err := validateCodexModelsPayload(body); err != nil {
		return nil, fmt.Errorf("invalid official models response: %w", err)
	}
	return body, nil
}

func validateCodexModelsPayload(body []byte) error {
	var envelope struct {
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return err
	}
	if len(envelope.Models) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Models), []byte("null")) {
		return fmt.Errorf("missing models array")
	}
	var models []json.RawMessage
	if err := json.Unmarshal(envelope.Models, &models); err != nil {
		return fmt.Errorf("models is not an array: %w", err)
	}
	return nil
}

func readCodexModelsCache() ([]byte, string, error) {
	body, err := os.ReadFile(filepath.Join(codexHomeDir(), "models_cache.json"))
	if err != nil {
		return nil, "", err
	}
	if err := validateCodexModelsPayload(body); err != nil {
		return nil, "", err
	}
	var metadata struct {
		ETag string `json:"etag"`
	}
	_ = json.Unmarshal(body, &metadata)
	return body, metadata.ETag, nil
}

func writeCodexModelsResponse(w http.ResponseWriter, body []byte, etag string) {
	w.Header().Set("Content-Type", "application/json")
	if etag != "" {
		w.Header().Set("ETag", etag)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
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
	// Responses API 的 input_tokens 是 gross(含 cached),AddModelTokens 约定 input 为净输入
	// (缓存读单独按缓存价计),故先还原净输入,否则缓存命中被整价+缓存价重复计(金额虚高)。
	netInput := details.InputTokens - details.CachedInputTokens
	if netInput < 0 {
		netInput = 0
	}
	GetUsageStats().AddModelTokens("gpt", details.ModelKey, netInput, details.OutputTokens, details.CachedInputTokens, details.RawTotalTokens, details.ServiceTier == codexFastServiceTier)
	GetUsageStats().AddGeneration()
}

// clientFacingCodexStatus 把要写回 codex 客户端的上游状态码做安全 remap:上游 401(号池 token
// 失效/被吊销)原样透传会触发 codex 的 refresh-on-401 —— 它拿本地伪 refresh_token 去真
// auth.openai.com 刷新 → 必失败 → 退回登录页。统一改写成 502,让客户端当作普通网关错误(可重试、
// 不重新登录);问题上报另用真实状态码,故服务端换号/标记坏号逻辑不受影响。其余状态码原样返回。
func clientFacingCodexStatus(upstream int) int {
	if upstream == http.StatusUnauthorized {
		return http.StatusBadGateway
	}
	return upstream
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

// codexEgressStripHeaders:转发上游前必须剥离的客户端头(小写)。
//   - x-oai-attestation:桌面 Codex 发的 Apple DeviceCheck 设备证明(硬件签名,不可伪造)。
//     它绑定「订户真机 ↔ 本次请求」。而我们用的是池号 token —— 一并透传 = 把「一个池号被多台
//     设备证明 / 一台设备证明多个池号」的池化关系亲手交给 OpenAI,是封号铁证。既无法为池号伪造
//     出「对得上的设备」,唯一安全做法就是不发真 token。
//     注意:这里只剥离**真 token**;池号路径(applyCodexOfficialHeaders)随后会回填一个
//     「生成失败」信封(codexAttestationFailureEnvelope, s:2),模拟 DeviceCheck 失败的真桌面,
//     既不泄漏绑定又与桌面身份自洽。relay 路径不回填(中转站不校验 ChatGPT 证明)。
var codexEgressStripHeaders = map[string]bool{
	"x-oai-attestation": true,
}

func copyCodexHeaders(dst, src http.Header) {
	for key, values := range src {
		lower := strings.ToLower(key)
		if lower == "host" || lower == "authorization" || lower == "content-length" {
			continue
		}
		if codexEgressStripHeaders[lower] {
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

// decodeCodexResponseStream 按 Content-Encoding 把上游响应体解成明文流,供边转边发 + usage 解析。
// 解压成功则删掉 Content-Encoding 头(下游收到的是明文,不能再声明原编码)。未压缩 / 未知编码
// 原样返回。底层 resp.Body 仍由调用方 defer 关闭(解压器只包一层,不额外持有资源)。
func decodeCodexResponseStream(resp *http.Response) io.Reader {
	enc := resp.Header.Get("Content-Encoding")
	if enc == "" {
		return resp.Body
	}
	dr, err := decompressReader(enc, resp.Body)
	if err != nil {
		return resp.Body // 解不了就原样透传(退化:usage 可能仍解析不到,但不影响转发)
	}
	resp.Header.Del("Content-Encoding")
	return dr
}

func isCodexStreamingResponse(resp *http.Response) bool {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(contentType, "text/event-stream")
}

// copyStreamingCodexResponse 边转发 SSE 边解析最终的 usage(input/output/total)。
// codex 流式响应的用量在 response.completed/response.done 事件的 response.usage 里,
// 之前只逐字节转发、不解析,导致流式用量上报为 0(完全不计费)。
func copyStreamingCodexResponse(w http.ResponseWriter, body io.Reader) (model string, input, output, cached, total int64, err error) {
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	var pending []byte

	// 边扫边抽:usage(计费数)+ model(上游实际使用的模型,归属权威源)。都在同一趟里取,
	// 不额外缓冲整包(auditTee 刻意不缓存 body)。model 取第一条带到的即可(各 response.* 事件都带)。
	handle := func(line []byte) {
		if i, o, c, t, ok := codexUsageFromSSELine(line); ok {
			input, output, cached, total = i, o, c, t
		} else if codexDebugUsage && bytes.Contains(line, []byte("usage")) {
			// 调试:解析不到但含 usage 的行,打出真实格式以便对齐字段路径。
			dbg := line
			if len(dbg) > 600 {
				dbg = dbg[:600]
			}
			Log("[codex-proxy][usage-dbg] 含usage但未解析: %s", string(bytes.TrimSpace(dbg)))
		}
		if model == "" {
			if m := codexModelFromSSELine(line); m != "" {
				model = m
			}
		}
	}
	scan := func(chunk []byte, flushTail bool) {
		pending = append(pending, chunk...)
		for {
			idx := bytes.IndexByte(pending, '\n')
			if idx < 0 {
				break
			}
			handle(pending[:idx])
			pending = pending[idx+1:]
		}
		if flushTail && len(pending) > 0 {
			handle(pending)
			pending = nil
		}
	}

	for {
		n, readErr := body.Read(buffer)
		if n > 0 {
			chunk := buffer[:n]
			scan(chunk, false)
			if _, writeErr := w.Write(chunk); writeErr != nil {
				return model, input, output, cached, total, writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			scan(nil, true)
			return model, input, output, cached, total, nil
		}
		if readErr != nil {
			return model, input, output, cached, total, readErr
		}
	}
}

// codexModelFromSSELine 从一行 SSE(`data: {...}`)中取上游实际使用的模型。
func codexModelFromSSELine(line []byte) string {
	trimmed := bytes.TrimSpace(line)
	trimmed = bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return ""
	}
	return codexModelFromJSON(trimmed)
}

// codexUsageFromSSELine 从一行 SSE(`data: {...}`)中解析 usage。
func codexUsageFromSSELine(line []byte) (input, output, cached, total int64, ok bool) {
	trimmed := bytes.TrimSpace(line)
	trimmed = bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return 0, 0, 0, 0, false
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
	input, output, cached, total := extractCodexUsage(body)
	return codexDetailsFrom(status, modelKey, input, output, cached, total)
}

// codexDetailsFrom 组装上报明细,并按缓存命中打 1/10 折扣(与 Gemini/Claude 同口径)。
// input 为 gross(含 cached);billable = raw - cached + ceil(cached/10)。
func codexDetailsFrom(status int, modelKey string, input, output, cached, total int64) ReportDetails {
	raw := total
	if raw == 0 {
		raw = input + output
	}
	if cached > input {
		cached = input
	}
	billable := raw
	if cached > 0 {
		billable = raw - cached + discountedCachedTokens(cached)
		if billable < 0 {
			billable = 0
		}
	}
	return ReportDetails{
		StatusCode:          status,
		ModelKey:            modelKey,
		InputTokens:         input,
		OutputTokens:        output,
		CachedInputTokens:   cached,
		ContextTokens:       input,
		RawTotalTokens:      raw,
		BillableTotalTokens: billable,
	}
}

func extractCodexUsage(body []byte) (int64, int64, int64, int64) {
	i, o, c, t, _ := codexUsageFromJSON(body)
	return i, o, c, t
}

// codexUsageFromJSON 从事件 JSON 中提取 usage,支持顶层 .usage 与 .response.usage
// (responses API 的 response.completed 事件把 usage 放在 response 下)。
func codexUsageFromJSON(data []byte) (input, output, cached, total int64, ok bool) {
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return 0, 0, 0, 0, false
	}
	usage, _ := payload["usage"].(map[string]interface{})
	if usage == nil {
		if resp, ok := payload["response"].(map[string]interface{}); ok {
			usage, _ = resp["usage"].(map[string]interface{})
		}
	}
	if usage == nil {
		return 0, 0, 0, 0, false
	}
	// NewAPI may return an OpenAI Chat Completions-shaped usage object even
	// when the request arrived through /responses. Accept both spellings so a
	// successful relay response cannot silently become an unbilled zero-token
	// request.
	input = jsonNumberAsInt64(usage["input_tokens"])
	if input == 0 {
		input = jsonNumberAsInt64(usage["prompt_tokens"])
	}
	output = jsonNumberAsInt64(usage["output_tokens"])
	if output == 0 {
		output = jsonNumberAsInt64(usage["completion_tokens"])
	}
	total = jsonNumberAsInt64(usage["total_tokens"])
	// 缓存命中:Responses API 把 cached_tokens 放在 input_tokens_details(已含于 input_tokens)。
	if det, ok := usage["input_tokens_details"].(map[string]interface{}); ok {
		cached = jsonNumberAsInt64(det["cached_tokens"])
	} else if det, ok := usage["prompt_tokens_details"].(map[string]interface{}); ok {
		cached = jsonNumberAsInt64(det["cached_tokens"])
	}
	if cached > input {
		cached = input
	}
	// 生图工具用量:responses.completed 把它单列在 tool_usage.image_gen,不在主 usage 里。
	// 折进 output/total 计费(生图 token 不漏计,避免池号成本泄漏)。见 [[codex-imagegen-metering]]。
	if imgIn, imgOut := codexImageToolTokens(payload); imgIn+imgOut > 0 {
		output += imgIn + imgOut
		total += imgIn + imgOut
	}
	if total == 0 {
		total = input + output
	}
	if input == 0 && output == 0 && total == 0 {
		return 0, 0, 0, 0, false
	}
	return input, output, cached, total, true
}

// codexImageToolTokens 取生图工具用量(tool_usage.image_gen,顶层或 response 下),
// 返回 input/output token。远程链路注入 hosted image_generation 后,生图消耗从这里计费。
func codexImageToolTokens(payload map[string]interface{}) (input, output int64) {
	toolUsage, _ := payload["tool_usage"].(map[string]interface{})
	if toolUsage == nil {
		if resp, ok := payload["response"].(map[string]interface{}); ok {
			toolUsage, _ = resp["tool_usage"].(map[string]interface{})
		}
	}
	img, _ := toolUsage["image_gen"].(map[string]interface{})
	if img == nil {
		return 0, 0
	}
	return jsonNumberAsInt64(img["input_tokens"]), jsonNumberAsInt64(img["output_tokens"])
}

// codexModelFromJSON 从事件 JSON 里取**上游实际使用**的模型:顶层 .model 或 .response.model
// (responses API 的事件把 model 放在 response 下)。这是计费归属的权威来源 —— 比请求里
// (可能缺失)的 model 或 config.toml 的猜测都准。
func codexModelFromJSON(data []byte) string {
	var payload struct {
		Model    string `json:"model"`
		Response struct {
			Model string `json:"model"`
		} `json:"response"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return ""
	}
	if strings.TrimSpace(payload.Response.Model) != "" {
		return payload.Response.Model
	}
	return payload.Model
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
