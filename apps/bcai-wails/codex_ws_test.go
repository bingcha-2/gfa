package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestIsCodexWebSocketUpgrade(t *testing.T) {
	mk := func(up, conn, key string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/backend-api/codex/responses", nil)
		if up != "" {
			r.Header.Set("Upgrade", up)
		}
		if conn != "" {
			r.Header.Set("Connection", conn)
		}
		if key != "" {
			r.Header.Set("Sec-WebSocket-Key", key)
		}
		return r
	}
	if !isCodexWebSocketUpgrade(mk("websocket", "Upgrade", "abc")) {
		t.Fatal("标准 ws 升级应被识别")
	}
	if !isCodexWebSocketUpgrade(mk("websocket", "keep-alive, Upgrade", "abc")) {
		t.Fatal("Connection 多值含 Upgrade 应被识别")
	}
	if isCodexWebSocketUpgrade(mk("", "Upgrade", "abc")) {
		t.Fatal("无 Upgrade 头不应识别")
	}
	if isCodexWebSocketUpgrade(mk("websocket", "Upgrade", "")) {
		t.Fatal("无 Sec-WebSocket-Key 不应识别")
	}
	if isCodexWebSocketUpgrade(mk("websocket", "keep-alive", "abc")) {
		t.Fatal("Connection 不含 Upgrade 不应识别")
	}
}

func TestSkipCodexWSHeader(t *testing.T) {
	skip := []string{"Authorization", "Host", "Connection", "Upgrade",
		"Sec-WebSocket-Key", "Sec-WebSocket-Version", "Accept-Encoding"}
	for _, h := range skip {
		if !skipCodexWSHeader(h) {
			t.Fatalf("%q 应被跳过(握手/鉴权头)", h)
		}
	}
	keep := []string{"OpenAI-Beta", "User-Agent", "Originator", "X-Custom"}
	for _, h := range keep {
		if skipCodexWSHeader(h) {
			t.Fatalf("%q 不应被跳过(业务头应透传)", h)
		}
	}
}

func TestParseCodexWSUsage(t *testing.T) {
	cases := []struct {
		name           string
		body           string
		in, out, total int64
		ok             bool
	}{
		{"顶层 usage", `{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}`, 10, 5, 15, true},
		{"嵌套 response.usage", `{"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}`, 7, 3, 10, true},
		{"total 缺失靠 in+out 推导", `{"usage":{"input_tokens":4,"output_tokens":6}}`, 4, 6, 10, true},
		{"无 usage", `{"type":"response.output_text.delta","delta":"hi"}`, 0, 0, 0, false},
		{"非 JSON", `not json`, 0, 0, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in, out, total, ok := parseCodexWSUsage([]byte(c.body))
			if ok != c.ok || in != c.in || out != c.out || total != c.total {
				t.Fatalf("got in=%d out=%d total=%d ok=%v, want in=%d out=%d total=%d ok=%v",
					in, out, total, ok, c.in, c.out, c.total, c.ok)
			}
		})
	}
}

// 端到端:Codex(下游 ws)→ 本地代理 → 假上游 wss。验证:
//   - 用号池 token(非下游 token)连上游
//   - 首帧 + 双向帧被转发
//   - 上游回的 usage 帧被解析并触发上报
func TestCodexWebSocketBridgeEndToEnd(t *testing.T) {
	var upstreamAuth string
	var upstreamBeta string
	// 假上游:校验头,回声首帧,再回一条带 usage 的完成帧。
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamAuth = r.Header.Get("Authorization")
		upstreamBeta = r.Header.Get("OpenAI-Beta")
		up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		// 读首帧(response.create)
		_, first, err := c.ReadMessage()
		if err != nil {
			return
		}
		if !strings.Contains(string(first), "response.create") {
			t.Errorf("上游未收到 response.create 首帧: %s", first)
		}
		// 回一条带 usage 的完成帧
		_ = c.WriteMessage(websocket.TextMessage,
			[]byte(`{"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20}}}`))
		// 等下游关闭
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer upstreamSrv.Close()

	// 用一个带 chatgpt_account_id 的假 JWT 当号池 token,验证 account-id 提取。
	poolToken := forgeFakeCodexJWT("pool-acct-xyz")

	reported := make(chan ReportDetails, 1)
	proxy := &CodexProxy{
		upstreamBase: strings.Replace(upstreamSrv.URL, "http://", "http://", 1),
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: poolToken, AccountId: 99}, nil
		},
		reportResult: func(card, deviceId string, d ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
			reported <- d
		},
	}

	// 本地代理 server:把 /backend-api/codex/responses 交给 CodexProxy。
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r, "codex-card", "device-a", "")
	}))
	defer proxySrv.Close()

	// 下游(模拟 Codex)用自己的 token 连本地代理,发 response.create。
	wsURL := strings.Replace(proxySrv.URL, "http://", "ws://", 1) + "/backend-api/codex/responses"
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer DOWNSTREAM-USER-TOKEN")
	down, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatalf("下游连本地代理失败: %v", err)
	}
	defer down.Close()

	if err := down.WriteMessage(websocket.TextMessage,
		[]byte(`{"type":"response.create","model":"gpt-5-codex"}`)); err != nil {
		t.Fatalf("发首帧失败: %v", err)
	}

	// 应收到上游回的 usage 帧
	_, msg, err := down.ReadMessage()
	if err != nil {
		t.Fatalf("读上游回帧失败: %v", err)
	}
	if !strings.Contains(string(msg), "total_tokens") {
		t.Fatalf("未收到上游 usage 帧: %s", msg)
	}
	down.Close()

	// 校验上游收到的是【号池】token,不是下游用户 token
	if upstreamAuth != "Bearer "+poolToken {
		t.Fatalf("上游应收到号池 token, got %q", upstreamAuth)
	}
	if !strings.Contains(upstreamBeta, "responses_websockets=") {
		t.Fatalf("上游应收到 ws beta 头, got %q", upstreamBeta)
	}

	// 校验用量上报(桥接在 goroutine 中收尾,上报是异步的,给它一点时间)。
	select {
	case d := <-reported:
		if d.BillableTotalTokens != 20 || d.InputTokens != 12 || d.OutputTokens != 8 {
			t.Fatalf("上报用量错误: %+v", d)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("应触发用量上报(等待超时)")
	}
}

// forgeFakeCodexJWT 造一个仅含 chatgpt_account_id 的假 JWT(三段,签名为假),
// 用于测试 extractChatGPTAccountId。
func forgeFakeCodexJWT(accountID string) string {
	header := base64URLNoPad(`{"alg":"RS256","typ":"JWT"}`)
	claims := base64URLNoPad(`{"https://api.openai.com/auth":{"chatgpt_account_id":"` + accountID + `"}}`)
	return header + "." + claims + ".fakesig"
}

func base64URLNoPad(s string) string {
	const tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	b := []byte(s)
	var out strings.Builder
	for i := 0; i < len(b); i += 3 {
		var n uint32
		k := 0
		for j := 0; j < 3; j++ {
			n <<= 8
			if i+j < len(b) {
				n |= uint32(b[i+j])
				k++
			}
		}
		for j := 0; j < 4; j++ {
			if j <= k {
				out.WriteByte(tbl[(n>>uint(18-6*j))&0x3f])
			}
		}
	}
	return out.String()
}
