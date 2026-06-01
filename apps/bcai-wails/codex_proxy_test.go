package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsCodexAPIRequest(t *testing.T) {
	positive := []string{
		"/v1/models",
		"/v1/responses",
		"/v1/responses/compact",
		"/v1/chat/completions",
	}
	for _, path := range positive {
		if !isCodexAPIRequest(path) {
			t.Fatalf("isCodexAPIRequest(%q) = false, want true", path)
		}
	}

	negative := []string{
		"/v1/models/gemini:streamGenerateContent",
		"/v1internal:fetchAvailableModels",
		"/health",
	}
	for _, path := range negative {
		if isCodexAPIRequest(path) {
			t.Fatalf("isCodexAPIRequest(%q) = true, want false", path)
		}
	}

	// antigravity 模式:Codex 把所有后端交互打到 /backend-api/codex/* → 都应被识别为
	// codex 请求(交给 CodexProxy 处理)。
	backendPaths := []string{
		"/backend-api/codex/responses",
		"/backend-api/codex/ps/plugins/installed",
		"/backend-api/codex/connectors/directory/list",
		"/backend-api/codex/wham/apps",
	}
	for _, path := range backendPaths {
		if !isCodexAPIRequest(path) {
			t.Fatalf("isCodexAPIRequest(%q) = false, want true", path)
		}
	}
}

// 验证生成/非生成分流:只有 responses 系列算生成(换号池 token),其余透传。
func TestIsCodexGenerationRequest(t *testing.T) {
	generation := []string{
		"/v1/responses",
		"/v1/responses/compact",
		"/v1/chat/completions",
		"/backend-api/codex/responses",
		"/backend-api/codex/responses/compact",
	}
	for _, path := range generation {
		if !isCodexGenerationRequest(path) {
			t.Fatalf("isCodexGenerationRequest(%q) = false, want true(应换号池 token)", path)
		}
	}

	passthrough := []string{
		"/backend-api/codex/ps/plugins/installed",
		"/backend-api/codex/plugins/featured",
		"/backend-api/codex/connectors/directory/list",
		"/backend-api/codex/wham/apps",
		"/backend-api/codex/wham/remote/control/server/enroll",
		"/backend-api/codex/codex/analytics-events/events",
	}
	for _, path := range passthrough {
		if isCodexGenerationRequest(path) {
			t.Fatalf("isCodexGenerationRequest(%q) = true, want false(应透传用户 token)", path)
		}
	}
}

func TestCodexProxyResponsesForwardsWithLeasedToken(t *testing.T) {
	reported := make(chan ReportDetails, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/backend-api/codex/responses" {
			t.Fatalf("upstream path = %s, want /backend-api/codex/responses", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer codex-access-token" {
			t.Fatalf("Authorization = %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"model":"gpt-5-codex"`) {
			t.Fatalf("request body missing model: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":     "resp_1",
			"object": "response",
			"usage": map[string]int{
				"input_tokens":  12,
				"output_tokens": 4,
				"total_tokens":  16,
			},
		})
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			if card != "codex-card" || deviceId != "device-a" {
				t.Fatalf("lease args card=%q deviceId=%q", card, deviceId)
			}
			return &CodexTokenLease{
				AccessToken: "codex-access-token",
				AccountId:   7,
				LeaseId:     "lease-7",
			}, nil
		},
		reportResult: func(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
			reported <- details
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	select {
	case details := <-reported:
		if details.StatusCode != 200 || details.ModelKey != "gpt-5-codex" || details.BillableTotalTokens != 16 {
			t.Fatalf("unexpected report details: %+v", details)
		}
	default:
		t.Fatal("expected usage report")
	}
}

// 非生成请求(插件列表等)应被本地吞掉:不调 lease、不打上游、GET 不被 405 拒,
// 返回 200 空集 JSON。这样 Codex 不会因这些可选杂活失败而死循环重试。
func TestCodexProxyNonGenerationSwallowed(t *testing.T) {
	upstreamHit := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHit = true
	}))
	defer upstream.Close()

	leaseCalled := false
	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			leaseCalled = true
			return &CodexTokenLease{AccessToken: "POOL-TOKEN"}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/backend-api/codex/ps/plugins/installed", nil)
	req.Header.Set("Authorization", "Bearer USER-OWN-TOKEN")
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if leaseCalled {
		t.Fatal("非生成请求不应调用 lease(不消耗号池额度)")
	}
	if upstreamHit {
		t.Fatal("非生成请求不应打到上游(应本地吞掉)")
	}
	if !strings.Contains(rec.Body.String(), "[]") {
		t.Fatalf("应返回空集 JSON, got %s", rec.Body.String())
	}
}

// POST 类非生成请求(wham/apps、analytics、enroll)同样被吞掉,不被 405、不打上游。
func TestCodexProxyNonGenerationPostSwallowed(t *testing.T) {
	upstreamHit := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHit = true
	}))
	defer upstream.Close()

	proxy := &CodexProxy{upstreamBase: upstream.URL}
	req := httptest.NewRequest(http.MethodPost, "/backend-api/codex/wham/remote/control/server/enroll", strings.NewReader(`{"x":1}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if upstreamHit {
		t.Fatal("非生成 POST 不应打到上游")
	}
}

// ─── 中转(API 卡密)模式 ──────────────────────────────────────────────────────
// relay 模式:不租号、不要 card、用本地配置的 key 直连第三方中转站。对照 cockpit
// 的 codex-api-key 路径:POST {base}/responses + Authorization: Bearer <key>,且
// 不发 Originator / ChatGPT-Account-Id 这些 ChatGPT 专属客户端头。

// 生成请求在 relay 模式下应:不调 lease、用配置的 key、打到 {base}/responses,
// 且即便 card 为空也放行(中转模式与号池无关)。
func TestCodexProxyRelayForwardsWithConfiguredKey(t *testing.T) {
	var gotAuth, gotOriginator, gotAccountID string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Fatalf("upstream path = %s, want /responses", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		gotOriginator = r.Header.Get("Originator")
		gotAccountID = r.Header.Get("ChatGPT-Account-Id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1","object":"response"}`)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		relay: &CodexRelayConfig{BaseURL: upstream.URL, APIKey: "relay-key-xyz"},
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			t.Fatal("relay 模式不应调用 lease(不消耗号池)")
			return nil, nil
		},
	}

	// card 故意留空:relay 模式与号池/卡密激活无关,不应被 401 拦。
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if gotAuth != "Bearer relay-key-xyz" {
		t.Fatalf("Authorization = %q, want Bearer relay-key-xyz", gotAuth)
	}
	// 对齐 cockpit:中转模式不发 ChatGPT 专属客户端头。
	if gotOriginator != "" {
		t.Fatalf("Originator = %q, want empty(中转模式不应发)", gotOriginator)
	}
	if gotAccountID != "" {
		t.Fatalf("ChatGPT-Account-Id = %q, want empty(中转模式不应发)", gotAccountID)
	}
}

// relay 模式不上报用量(额度不管、与号池不关联)。
func TestCodexProxyRelaySkipsUsageReport(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":     "resp_1",
			"object": "response",
			"usage":  map[string]int{"input_tokens": 12, "output_tokens": 4, "total_tokens": 16},
		})
	}))
	defer upstream.Close()

	reportCalled := false
	proxy := &CodexProxy{
		relay: &CodexRelayConfig{BaseURL: upstream.URL, APIKey: "relay-key"},
		reportResult: func(card, deviceId string, details ReportDetails, upstreamProxy string, lease *CodexTokenLease) {
			reportCalled = true
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if reportCalled {
		t.Fatal("relay 模式不应上报用量(额度不管)")
	}
}

// relay 模式按配置的模型映射改写请求体的 model 字段(中转站模型名可能与本地不同)。
func TestCodexProxyRelayMapsModelName(t *testing.T) {
	var gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"r","object":"response"}`)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		relay: &CodexRelayConfig{
			BaseURL:  upstream.URL,
			APIKey:   "relay-key",
			ModelMap: map[string]string{"gpt-5-codex": "anthropic/claude-via-relay"},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotBody, `"model":"anthropic/claude-via-relay"`) {
		t.Fatalf("relay 应改写 model, got %s", gotBody)
	}
}

// 未配置映射时,relay 模式原样透传 model 名。
func TestCodexProxyRelayModelPassthroughWhenNoMap(t *testing.T) {
	var gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"r","object":"response"}`)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{relay: &CodexRelayConfig{BaseURL: upstream.URL, APIKey: "relay-key"}}

	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(gotBody, `"model":"gpt-5-codex"`) {
		t.Fatalf("未配置映射应原样透传 model, got %s", gotBody)
	}
}

// relay 模式下,非生成请求仍被本地吞掉(与号池模式一致,无需 card)。
func TestCodexProxyRelayNonGenerationSwallowed(t *testing.T) {
	upstreamHit := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHit = true
	}))
	defer upstream.Close()

	proxy := &CodexProxy{relay: &CodexRelayConfig{BaseURL: upstream.URL, APIKey: "relay-key"}}
	req := httptest.NewRequest(http.MethodGet, "/backend-api/codex/ps/plugins/installed", nil)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if upstreamHit {
		t.Fatal("非生成请求不应打到上游")
	}
}

// compact 生成请求在 relay 模式下应落到 {base}/responses/compact(对齐 cockpit
// executeCompact 的上游路径),而非 /responses。
func TestCodexProxyRelayCompactPath(t *testing.T) {
	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"r","object":"response"}`)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{relay: &CodexRelayConfig{BaseURL: upstream.URL, APIKey: "relay-key"}}
	req := httptest.NewRequest(http.MethodPost, "/backend-api/codex/responses/compact", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/responses/compact" {
		t.Fatalf("upstream path = %s, want /responses/compact", gotPath)
	}
}
