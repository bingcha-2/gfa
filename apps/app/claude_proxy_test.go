package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func withAnthropicAPIBase(t *testing.T, base string) {
	t.Helper()
	prev := ANTHROPIC_API_BASE
	ANTHROPIC_API_BASE = base
	t.Cleanup(func() { ANTHROPIC_API_BASE = prev })
}

func decodeClaudeProxyErrorMessage(t *testing.T, body []byte) string {
	t.Helper()
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("failed to decode proxy error body %q: %v", string(body), err)
	}
	return payload.Error.Message
}

func TestIsClaudeAPIRequest(t *testing.T) {
	yes := []string{"/v1/messages", "/v1/messages/count_tokens"}
	no := []string{"/v1/responses", "/v1/chat/completions", "/health", "/loadCodeAssist"}
	for _, p := range yes {
		if !isClaudeAPIRequest(p) {
			t.Errorf("isClaudeAPIRequest(%q) should be true", p)
		}
	}
	for _, p := range no {
		if isClaudeAPIRequest(p) {
			t.Errorf("isClaudeAPIRequest(%q) should be false", p)
		}
	}
}

func TestClaudeProxyStreamsAndMeters(t *testing.T) {
	// Upstream "Anthropic" returns an SSE stream and echoes that we swapped auth.
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/v1/messages" {
			t.Errorf("upstream path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(sampleClaudeSSE))
	}))
	defer upstream.Close()
	withAnthropicAPIBase(t, upstream.URL)

	var reported ReportDetails
	reportedOK := false
	p := &ClaudeProxy{
		leaseToken: func(card, deviceId string, force bool, opts map[string]interface{}, up string) (*ClaudeTokenLease, error) {
			// ProxyURL 非空才能过 fail-closed 出口闸;实际连接走下面注入的 client。
			return &ClaudeTokenLease{AccessToken: "sk-ant-oauth-leased", AccountId: 1, LeaseId: "lease-1", EgressInfo: EgressInfo{ProxyURL: "http://egress.test:8080", EgressRequired: true}}, nil
		},
		reportUsage: func(card, deviceId string, d ReportDetails, up string, lease *ClaudeTokenLease) {
			reported = d
			reportedOK = true
		},
		// 注入明文 httptest client(绕开生产的 utls TLS 出口),直连测试上游。
		upstreamClient: func(string) *http.Client { return upstream.Client() },
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-opus-4-20250514","stream":true,"messages":[]}`))
	req.Header.Set("anthropic-version", "2023-06-01")
	rw := httptest.NewRecorder()

	p.ServeHTTP(rw, req, "card-1", "dev-1", "")

	if rw.Body.String() != sampleClaudeSSE {
		t.Fatalf("downstream did not receive the upstream SSE byte-for-byte")
	}
	if gotAuth != "Bearer sk-ant-oauth-leased" {
		t.Fatalf("proxy must swap Authorization to the leased token, got %q", gotAuth)
	}
	if !reportedOK {
		t.Fatal("usage was not reported")
	}
	if reported.InputTokens != 1000 || reported.OutputTokens != 350 {
		t.Fatalf("reported usage wrong: in=%d out=%d", reported.InputTokens, reported.OutputTokens)
	}
	if reported.ModelKey != "claude-opus-4-20250514" {
		t.Fatalf("reported modelKey = %q", reported.ModelKey)
	}
	// raw total includes cache tokens: 1000 + 350 + 50 + 200
	if reported.RawTotalTokens != 1600 {
		t.Fatalf("reported rawTotal = %d, want 1600", reported.RawTotalTokens)
	}
	if reported.CachedInputTokens != 200 {
		t.Fatalf("reported cachedInputTokens = %d, want 200 (cache_read)", reported.CachedInputTokens)
	}
}

func TestClaudeProxyEnsuresOAuthBetaHeader(t *testing.T) {
	// api.anthropic.com rejects OAuth (sk-ant-oat...) tokens unless the request
	// carries anthropic-beta: oauth-2025-04-20. In custom-base-url mode Claude Code
	// may omit it, so the proxy must guarantee it (merging with any existing betas).
	var gotBeta string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBeta = r.Header.Get("anthropic-beta")
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(sampleClaudeSSE))
	}))
	defer upstream.Close()
	withAnthropicAPIBase(t, upstream.URL)

	p := &ClaudeProxy{
		leaseToken: func(card, deviceId string, force bool, opts map[string]interface{}, up string) (*ClaudeTokenLease, error) {
			return &ClaudeTokenLease{AccessToken: "sk-ant-oauth", AccountId: 1, LeaseId: "l1", EgressInfo: EgressInfo{ProxyURL: "http://egress.test:8080", EgressRequired: true}}, nil
		},
		reportUsage:    func(string, string, ReportDetails, string, *ClaudeTokenLease) {},
		upstreamClient: func(string) *http.Client { return upstream.Client() },
	}

	// Incoming request carries an unrelated beta but NOT the oauth one.
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-x","stream":true}`))
	req.Header.Set("anthropic-beta", "fine-grained-tool-streaming-2025-05-14")
	rw := httptest.NewRecorder()
	p.ServeHTTP(rw, req, "card-1", "dev-1", "")

	if !strings.Contains(gotBeta, "oauth-2025-04-20") {
		t.Fatalf("upstream anthropic-beta must contain oauth-2025-04-20, got %q", gotBeta)
	}
	if !strings.Contains(gotBeta, "fine-grained-tool-streaming-2025-05-14") {
		t.Fatalf("existing beta flags must be preserved, got %q", gotBeta)
	}
}

func TestClaudeProxyIncludesTransportDetailsForClient(t *testing.T) {
	rawErr := `socks connect tcp 173.44.178.29:443->api.anthropic.com:443: EOF`
	var reported ReportDetails
	reportedOK := false
	p := &ClaudeProxy{
		leaseToken: func(card, deviceId string, force bool, opts map[string]interface{}, up string) (*ClaudeTokenLease, error) {
			return &ClaudeTokenLease{AccessToken: "sk-ant-oauth", AccountId: 4, LeaseId: "l1", EgressInfo: EgressInfo{ProxyURL: "socks5://173.44.178.29:443", EgressRequired: true}}, nil
		},
		reportProblem: func(card, deviceId string, d ReportDetails, up string, lease *ClaudeTokenLease) {
			reported = d
			reportedOK = true
		},
		upstreamClient: func(string) *http.Client {
			return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New(rawErr)
			})}
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-opus-4-8","stream":true}`))
	rw := httptest.NewRecorder()
	p.ServeHTTP(rw, req, "card-1", "dev-1", "")

	if rw.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rw.Code)
	}
	message := decodeClaudeProxyErrorMessage(t, rw.Body.Bytes())
	wantMessage := "冰茶AI 正在重试连接 Claude。当前请求未能通过你的出口代理建立稳定连接，通常是本机网络、VPN 节点或代理链路临时不通导致。如果持续出现，请切换 VPN 节点或检查本机网络。"
	if !strings.Contains(message, wantMessage) {
		t.Fatalf("client error message = %q, want friendly message %q", message, wantMessage)
	}
	// 保留可定位的原因(EOF),但不暴露出口/住宅代理地址(IP 抹成占位符)。
	if !strings.Contains(message, "原始错误: ") || !strings.Contains(message, "EOF") {
		t.Fatalf("client error message = %q, want sanitized transport reason (…EOF)", message)
	}
	if strings.Contains(message, "173.44.178.29") {
		t.Fatalf("client error message leaked proxy IP: %q", message)
	}
	if !reportedOK {
		t.Fatal("problem was not reported")
	}
	if !strings.Contains(reported.ErrorText, rawErr) {
		t.Fatalf("reported raw error = %q, want it to contain %q", reported.ErrorText, rawErr)
	}
}

func TestClaudeTransportAuditNoteIncludesSanitizedConnectionResetDetails(t *testing.T) {
	rawErr := `read tcp 198.18.0.1:53930->216.175.200.154:443: wsarecv: An existing connection was forcibly closed by the remote host.`
	note := claudeTransportAuditNote(errors.New(rawErr))

	if !strings.Contains(note, claudeTransportFriendlyMessage) {
		t.Fatalf("audit note = %q, want friendly message %q", note, claudeTransportFriendlyMessage)
	}
	if !strings.Contains(note, "原始错误: ") || !strings.Contains(note, "wsarecv") || !strings.Contains(note, "forcibly closed") {
		t.Fatalf("audit note = %q, want sanitized connection reset details", note)
	}
	if strings.Contains(note, "198.18.0.1") || strings.Contains(note, "216.175.200.154") {
		t.Fatalf("audit note leaked raw IP details: %q", note)
	}
}

// 出口代理不一定是 IPv4——供应商常给域名 endpoint,也可能是 IPv6。这些都不能漏给客户。
func TestSanitizeTransportErrorHidesProxyHostForms(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		egress  string
		secret  string // 必须从输出里消失的敏感串
		keepHas string // 必须保留的原因关键字
	}{
		{
			name:    "域名形式代理",
			raw:     `proxyconnect tcp: dial tcp: lookup gw.residential-vendor.com: no such host`,
			egress:  "http://user:pass@gw.residential-vendor.com:8080",
			secret:  "gw.residential-vendor.com",
			keepHas: "no such host",
		},
		{
			name:    "IPv6 形式代理(带方括号端口)",
			raw:     `socks connect tcp [2001:db8::dead:beef]:1080->api.anthropic.com:443: i/o timeout`,
			egress:  "socks5://[2001:db8::dead:beef]:1080",
			secret:  "2001:db8",
			keepHas: "i/o timeout",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := sanitizeTransportError(errors.New(c.raw), c.egress)
			if strings.Contains(got, c.secret) {
				t.Fatalf("sanitized = %q leaked proxy secret %q", got, c.secret)
			}
			if !strings.Contains(got, c.keepHas) {
				t.Fatalf("sanitized = %q dropped reason keyword %q", got, c.keepHas)
			}
		})
	}
}

func TestClaudeProxyRejectsWithoutCard(t *testing.T) {
	p := &ClaudeProxy{}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-x"}`))
	rw := httptest.NewRecorder()
	p.ServeHTTP(rw, req, "", "dev-1", "")
	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("no-card should be 401, got %d", rw.Code)
	}
}

func TestClaudeProxyRejectsNonPost(t *testing.T) {
	p := &ClaudeProxy{}
	req := httptest.NewRequest(http.MethodGet, "/v1/messages", nil)
	rw := httptest.NewRecorder()
	p.ServeHTTP(rw, req, "card-1", "dev-1", "")
	if rw.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /v1/messages should be 405, got %d", rw.Code)
	}
}

// parseClaudeUnifiedWindows: 缺头的窗口必须如实上报 -1(未知),绝不退回 0 假装耗尽——
// 否则上游 200 漏带 7d 头时会被服务端落库成 weekly=0,把健康号打到最后兜底。
func TestParseClaudeUnifiedWindowsAbsentWindowIsUnknown(t *testing.T) {
	h := http.Header{}
	h.Set("Anthropic-Ratelimit-Unified-5h-Utilization", "0.2")
	h.Set("Anthropic-Ratelimit-Unified-5h-Reset", "1700000000")
	// 7d 头故意缺失
	hp, wp, hr, wr, ok := parseClaudeUnifiedWindows(h)
	if !ok {
		t.Fatal("ok should be true when the 5h window is present")
	}
	if hp != 80 {
		t.Errorf("hourly = %v, want 80", hp)
	}
	if wp != -1 {
		t.Errorf("weekly = %v, want -1 (unknown), not a fabricated 0", wp)
	}
	if hr == "" {
		t.Error("hourly reset should be set")
	}
	if wr != "" {
		t.Errorf("weekly reset = %q, want empty", wr)
	}
}

func TestParseClaudeUnifiedWindowsBothPresent(t *testing.T) {
	h := http.Header{}
	h.Set("Anthropic-Ratelimit-Unified-5h-Utilization", "0.1")
	h.Set("Anthropic-Ratelimit-Unified-7d-Utilization", "0.4")
	hp, wp, _, _, ok := parseClaudeUnifiedWindows(h)
	if !ok || hp != 90 || wp != 60 {
		t.Errorf("got ok=%v hourly=%v weekly=%v, want ok=true 90 60", ok, hp, wp)
	}
}

func TestParseClaudeUnifiedWindowsNoneIsNotOk(t *testing.T) {
	hp, wp, _, _, ok := parseClaudeUnifiedWindows(http.Header{})
	if ok {
		t.Error("ok should be false when no window headers are present")
	}
	if hp != -1 || wp != -1 {
		t.Errorf("both should be -1 (unknown), got hourly=%v weekly=%v", hp, wp)
	}
}

func TestEnsureOAuthBeta_ClientAlreadyHasOAuth(t *testing.T) {
	// 客户端带了新版 oauth flag → 原样保留,不追加硬编码旧值
	got := ensureOAuthBeta("prompt-caching-2025-04-11,oauth-2025-09-01", "oauth-2025-04-20")
	if strings.Contains(got, "oauth-2025-04-20") {
		t.Fatalf("should NOT inject fallback when client already has oauth flag, got %q", got)
	}
	if !strings.Contains(got, "oauth-2025-09-01") {
		t.Fatalf("should preserve client's oauth flag, got %q", got)
	}
}

func TestEnsureOAuthBeta_NoOAuthFlag(t *testing.T) {
	// 客户端没带任何 oauth flag → 用兜底值补
	got := ensureOAuthBeta("prompt-caching-2025-04-11", "oauth-2025-04-20")
	if !strings.Contains(got, "oauth-2025-04-20") {
		t.Fatalf("should inject fallback when no oauth flag, got %q", got)
	}
	if !strings.Contains(got, "prompt-caching-2025-04-11") {
		t.Fatalf("should preserve existing flags, got %q", got)
	}
}

func TestEnsureOAuthBeta_Empty(t *testing.T) {
	// 完全空 → 用兜底值
	got := ensureOAuthBeta("", "oauth-2025-04-20")
	if got != "oauth-2025-04-20" {
		t.Fatalf("expected fallback, got %q", got)
	}
}

func TestApplyClaudeUpstreamHeaders_EmptyBetaUsesFullFallback(t *testing.T) {
	// base_url 模式:客户端没带 anthropic-beta → 补整套兜底(对照真 desktop),非裸 oauth flag。
	dst := http.Header{}
	applyClaudeUpstreamHeaders(dst, http.Header{}, "oat", "https://api.anthropic.com/v1/messages", 1)
	if got := dst.Get("Anthropic-Beta"); got != claudeFallbackBeta {
		t.Fatalf("空 beta 应补整套兜底\n want %s\n got  %s", claudeFallbackBeta, got)
	}
	if got := dst.Get("Anthropic-Version"); got != "2023-06-01" {
		t.Fatalf("anthropic-version 应补 2023-06-01, got %q", got)
	}
}

func TestApplyClaudeUpstreamHeaders_ExistingBetaJustEnsuresOAuth(t *testing.T) {
	// 客户端已带自己的 beta(无 oauth)→ 只补 oauth flag,不强加整套兜底。
	src := http.Header{}
	src.Set("Anthropic-Beta", "claude-code-20250219,context-management-2025-06-27")
	dst := http.Header{}
	applyClaudeUpstreamHeaders(dst, src, "oat", "https://api.anthropic.com/v1/messages", 1)
	got := dst.Get("Anthropic-Beta")
	if !strings.Contains(got, "claude-code-20250219") || !strings.Contains(got, "oauth-2025-04-20") {
		t.Fatalf("应保留客户端 beta 并补 oauth flag, got %q", got)
	}
	if strings.Contains(got, "interleaved-thinking") {
		t.Fatal("客户端已带 beta 时不应强加整套兜底")
	}
}
