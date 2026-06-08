package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Codex WebSocket 中间人 ─────────────────────────────────────────────────
//
// 新版 Codex 桌面版的对话(生成)不走 HTTP POST /responses,而是开一条 WebSocket
// 长连接到 chatgpt_base_url 派生的 wss 端点,用 response.create 消息发起生成。
// 纯 HTTP 代理拦不到,所以这里实现 ws 中间人(对照 cockpit codex_local_access.rs):
//
//   Codex ──ws──▶ 本地代理(换号池 token)──wss──▶ chatgpt.com
//
//  1. 识别 ws 升级请求 → gorilla Upgrader 接管下游(自动完成握手)
//  2. 读首帧 response.create → 从号池 lease 一个会员 token
//  3. websocket.Dialer 拨 wss://chatgpt.com,带 Authorization=Bearer<号池token>
//     + OpenAI-Beta: responses_websockets=... + ChatGPT-Account-Id + UA/Originator
//  4. 双向全双工泵帧;扫描上行/下行帧里的 usage 做计量,复用 reportUsageSafe 上报
//
// refresh_token 永不下发:号池 token 由服务器侧轮换,客户端只拿短期 access。

const (
	codexWSBetaHeader = "responses_websockets=2026-02-06"
	// 默认身份头对齐 HTTP 路径(codexDefaultUserAgent / codexDefaultOriginator),
	// 避免裸 "codex-cli" 这种明显非官方客户端的 UA 被上游按指纹拦截。仅在下游未带时补。
	codexWSDefaultUA       = codexDefaultUserAgent
	codexWSDefaultOrigin   = codexDefaultOriginator
	codexWSConnectTimeout  = 30 * time.Second
	codexWSInitMsgTimeout  = 30 * time.Second
	codexWSHandshakeBuffer = 64 * 1024
)

// isCodexWebSocketUpgrade 判断是否是 ws 升级请求。
func isCodexWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return false
	}
	connOK := false
	for _, part := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(part), "upgrade") {
			connOK = true
			break
		}
	}
	return connOK && r.Header.Get("Sec-WebSocket-Key") != ""
}

var codexWSUpgrader = websocket.Upgrader{
	ReadBufferSize:  codexWSHandshakeBuffer,
	WriteBufferSize: codexWSHandshakeBuffer,
	// Codex 是本地客户端,放行所有 Origin。
	CheckOrigin: func(r *http.Request) bool { return true },
	// 透传 Codex 请求的子协议(若有)。
	Subprotocols: nil,
}

// 这些上游握手头由 dialer/我们自己设置,不从下游原样透传。
func skipCodexWSHeader(name string) bool {
	switch strings.ToLower(name) {
	case "authorization", "host", "content-length", "connection", "upgrade",
		"sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol",
		"sec-websocket-extensions", "accept-encoding", "proxy-connection":
		return true
	default:
		return false
	}
}

// serveCodexWebSocket 处理一条 Codex ws 生成连接的完整生命周期。
func (p *CodexProxy) serveCodexWebSocket(w http.ResponseWriter, r *http.Request, card, deviceId, upstreamProxy string) {
	reqID := atomic.AddInt64(&p.totalRequests, 1)
	Log("[codex-proxy] #%d [WS] 收到 ws 升级 %s", reqID, r.URL.Path)

	if card == "" {
		p.sendJSONError(w, http.StatusUnauthorized, "Codex account card is not configured")
		return
	}

	// 1. 接管下游(对 Codex 完成 101 握手)。
	down, err := codexWSUpgrader.Upgrade(w, r, http.Header{
		"Access-Control-Allow-Origin": {"*"},
	})
	if err != nil {
		// Upgrade 失败时 gorilla 已写过错误响应,这里只记日志。
		Log("[codex-proxy] #%d [WS] 下游握手失败: %v", reqID, err)
		return
	}
	defer down.Close()

	// 2. 读首帧(response.create)。
	down.SetReadDeadline(time.Now().Add(codexWSInitMsgTimeout))
	msgType, initial, err := readFirstCodexWSFrame(down)
	if err != nil {
		Log("[codex-proxy] #%d [WS] 读首帧失败: %v", reqID, err)
		_ = down.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "no initial frame"))
		return
	}
	down.SetReadDeadline(time.Time{}) // 清除截止时间,后续靠桥接的 idle 控制

	modelKey := extractCodexModelKey(initial)
	if modelKey == "" {
		modelKey = "gpt-5-codex"
	}

	// 3. 从号池租号池 token。
	leaseFunc := p.leaseToken
	if leaseFunc == nil {
		leaseFunc = GetCodexLeaser().LeaseToken
	}
	lease, err := leaseFunc(card, deviceId, true, map[string]interface{}{
		"modelKey":  modelKey,
		"bodyBytes": len(initial),
		"transport": "websocket",
	}, upstreamProxy)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		Log("[codex-proxy] #%d [WS] 租号失败: %v", reqID, err)
		_ = down.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "token lease failed"))
		return
	}
	Log("[codex-proxy] #%d [WS][生成] %s model=%s → 用号池token accountId=%d(已替换Codex本地token)",
		reqID, r.URL.Path, modelKey, lease.AccountId)

	// 4. 拨上游 wss。
	up, err := p.dialCodexUpstreamWS(r, lease, upstreamProxy)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		Log("[codex-proxy] #%d [WS] 连上游失败: %v", reqID, err)
		p.reportProblemSafe(card, deviceId, ReportDetails{
			StatusCode: 502, ModelKey: modelKey, Reason: "ws_upstream_connect_error", ErrorText: err.Error(),
		}, upstreamProxy, lease)
		_ = down.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "upstream connect failed"))
		return
	}
	defer up.Close()

	// 5. 先把首帧转给上游,再双向桥接。换号后剔除首帧 response.create 里非法的
	//    reasoning.encrypted_content(上一个账号的签名对新账号无效,留着上游报错)。
	if msgType == websocket.TextMessage {
		if cleaned, dropped := sanitizeCodexReasoningEncryptedContent(initial); dropped > 0 {
			initial = cleaned
			Log("[codex-proxy] #%d [WS][生成] 剔除 %d 条非法 reasoning.encrypted_content(换号签名失配)", reqID, dropped)
		}
	}
	if err := up.WriteMessage(msgType, initial); err != nil {
		Log("[codex-proxy] #%d [WS] 转发首帧失败: %v", reqID, err)
		return
	}

	usage := p.bridgeCodexWS(reqID, down, up, time.Now())

	// 6. 计量上报(缓存命中按 1/10 折扣,与 HTTP 路径同口径)。
	details := codexDetailsFrom(200, modelKey, usage.input, usage.output, usage.cached, usage.total)
	if usage.total > 0 {
		Log("[codex-proxy] #%d [WS][生成] ✓ TTFT=%dms tokens(in=%d out=%d total=%d) → 已提交用量上报",
			reqID, usage.ttftMs, usage.input, usage.output, usage.total)
		p.reportUsageSafe(card, deviceId, details, upstreamProxy, lease)
	} else {
		Log("[codex-proxy] #%d [WS][生成] 连接结束,未解析到 usage(可能被中断或上游未返回用量)", reqID)
	}
}

// readFirstCodexWSFrame 读下游第一条数据帧(text/binary),期间自动回应 ping。
func readFirstCodexWSFrame(down *websocket.Conn) (int, []byte, error) {
	for {
		mt, data, err := down.ReadMessage()
		if err != nil {
			return 0, nil, err
		}
		switch mt {
		case websocket.TextMessage, websocket.BinaryMessage:
			return mt, data, nil
		default:
			// ping/pong 由 gorilla 默认 handler 处理,这里继续读。
			continue
		}
	}
}

// dialCodexUpstreamWS 把请求的 http(s) 目标派生为 wss 并拨号,注入号池 token 与官方头。
func (p *CodexProxy) dialCodexUpstreamWS(r *http.Request, lease *CodexTokenLease, upstreamProxy string) (*websocket.Conn, error) {
	// 上游 http URL(复用现有 targetURL 逻辑)→ 切 ws/wss。
	httpTarget, err := p.targetURL(r)
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(httpTarget)
	if err != nil {
		return nil, fmt.Errorf("上游 ws URL 解析失败: %w", err)
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	default:
		return nil, fmt.Errorf("上游 ws 不支持 %s 协议", parsed.Scheme)
	}

	// 透传下游头(跳过握手/鉴权头),再覆盖鉴权与官方头。
	hdr := http.Header{}
	for name, values := range r.Header {
		if skipCodexWSHeader(name) {
			continue
		}
		for _, v := range values {
			hdr.Add(name, v)
		}
	}
	hdr.Set("Authorization", "Bearer "+lease.AccessToken)
	if acct := extractChatGPTAccountId(lease.AccessToken); acct != "" {
		hdr.Set("ChatGPT-Account-Id", acct)
	} else {
		hdr.Del("ChatGPT-Account-Id")
	}
	if r.Header.Get("User-Agent") == "" {
		hdr.Set("User-Agent", codexWSDefaultUA)
	}
	if r.Header.Get("Originator") == "" {
		hdr.Set("Originator", codexWSDefaultOrigin)
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("OpenAI-Beta")), "responses_websockets=") {
		hdr.Set("OpenAI-Beta", codexWSBetaHeader)
	}

	dialer := &websocket.Dialer{
		HandshakeTimeout: codexWSConnectTimeout,
		Proxy:            codexWSProxyFunc(upstreamProxy),
	}

	ctx, cancel := context.WithTimeout(context.Background(), codexWSConnectTimeout)
	defer cancel()
	up, resp, err := dialer.DialContext(ctx, parsed.String(), hdr)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("上游 ws 握手失败 http=%d: %w", resp.StatusCode, err)
		}
		return nil, fmt.Errorf("上游 ws 拨号失败: %w", err)
	}
	return up, nil
}

// codexWSProxyFunc 把上游代理地址转成 dialer 的 Proxy 函数(空则直连)。
func codexWSProxyFunc(upstreamProxy string) func(*http.Request) (*url.URL, error) {
	p := strings.TrimSpace(upstreamProxy)
	if p == "" {
		return nil
	}
	pu, err := url.Parse(p)
	if err != nil {
		return nil
	}
	return http.ProxyURL(pu)
}

type codexWSUsage struct {
	input  int64
	output int64
	cached int64
	total  int64
	ttftMs int64 // 首个下行(上游→Codex)数据帧时延;未收到则为 -1
}

// bridgeCodexWS 双向全双工泵帧,直到任一方关闭。扫描两个方向的帧解析 usage。
func (p *CodexProxy) bridgeCodexWS(reqID int64, down, up *websocket.Conn, start time.Time) codexWSUsage {
	usage := codexWSUsage{ttftMs: -1}
	var usageMu sync.Mutex
	var once sync.Once
	done := make(chan struct{})
	closeOnce := func() { once.Do(func() { close(done) }) }

	scan := func(data []byte) {
		if in, out, cached, total, ok := parseCodexWSUsage(data); ok {
			usageMu.Lock()
			if total > usage.total {
				usage.input, usage.output, usage.cached, usage.total = in, out, cached, total
			}
			usageMu.Unlock()
		}
	}

	// 上行:下游 Codex → 上游 chatgpt.com
	go func() {
		defer closeOnce()
		for {
			mt, data, err := down.ReadMessage()
			if err != nil {
				_ = up.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			if mt == websocket.TextMessage || mt == websocket.BinaryMessage {
				scan(data)
			}
			if err := up.WriteMessage(mt, data); err != nil {
				return
			}
		}
	}()

	// 下行:上游 chatgpt.com → 下游 Codex
	go func() {
		defer closeOnce()
		for {
			mt, data, err := up.ReadMessage()
			if err != nil {
				_ = down.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			if mt == websocket.TextMessage || mt == websocket.BinaryMessage {
				usageMu.Lock()
				if usage.ttftMs < 0 {
					usage.ttftMs = time.Since(start).Milliseconds()
				}
				usageMu.Unlock()
				scan(data)
			}
			if err := down.WriteMessage(mt, data); err != nil {
				return
			}
		}
	}()

	<-done
	usageMu.Lock()
	defer usageMu.Unlock()
	return usage
}

// parseCodexWSUsage 从一条 ws 帧(JSON)里尽力解析 token 用量。
// Codex 的 responses 事件里 usage 可能在顶层、或 response.usage、或 payload.usage。
func parseCodexWSUsage(data []byte) (input, output, cached, total int64, ok bool) {
	var m map[string]interface{}
	if json.Unmarshal(data, &m) != nil {
		return 0, 0, 0, 0, false
	}
	if u := findUsageMap(m, 0); u != nil {
		input = jsonInt(u["input_tokens"])
		output = jsonInt(u["output_tokens"])
		total = jsonInt(u["total_tokens"])
		// 缓存命中:cached_tokens 在 input_tokens_details(已含于 input_tokens)。
		if det, ok := u["input_tokens_details"].(map[string]interface{}); ok {
			cached = jsonInt(det["cached_tokens"])
		}
		if cached > input {
			cached = input
		}
		if total == 0 {
			total = input + output
		}
		if total > 0 {
			return input, output, cached, total, true
		}
	}
	return 0, 0, 0, 0, false
}

// findUsageMap 在 JSON 树里递归找名为 "usage" 的对象(限制深度避免极端嵌套)。
func findUsageMap(v interface{}, depth int) map[string]interface{} {
	if depth > 6 {
		return nil
	}
	m, ok := v.(map[string]interface{})
	if !ok {
		return nil
	}
	if u, ok := m["usage"].(map[string]interface{}); ok {
		return u
	}
	for _, child := range m {
		if found := findUsageMap(child, depth+1); found != nil {
			return found
		}
	}
	return nil
}

func jsonInt(v interface{}) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case json.Number:
		i, _ := n.Int64()
		return i
	default:
		return 0
	}
}
