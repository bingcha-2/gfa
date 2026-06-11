package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func withAnthropicAPIBase(t *testing.T, base string) {
	t.Helper()
	prev := ANTHROPIC_API_BASE
	ANTHROPIC_API_BASE = base
	t.Cleanup(func() { ANTHROPIC_API_BASE = prev })
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
