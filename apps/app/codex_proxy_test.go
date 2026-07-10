package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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

func TestCodexBuiltInProviderWebSocketFallsBackToHTTP(t *testing.T) {
	proxy := &CodexProxy{
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			t.Fatal("WebSocket fallback must not lease a token")
			return nil, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/responses", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	req.Header.Set("Sec-WebSocket-Version", "13")
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "direct")

	if rec.Code != http.StatusUpgradeRequired {
		t.Fatalf("status = %d, want 426", rec.Code)
	}

	post := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5.6-sol"}`))
	postRec := httptest.NewRecorder()
	proxy.ServeHTTP(postRec, post, "", "device-a", "direct")
	if postRec.Code == http.StatusUpgradeRequired {
		t.Fatal("普通 POST /v1/responses 不应进入 WebSocket fallback")
	}
}

func TestCodexModelsPassthrough(t *testing.T) {
	const accountID = "acct-models-56"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/backend-api/codex/models" {
			t.Fatalf("upstream request = %s %s, want GET /backend-api/codex/models", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("client_version"); got != "0.144.0" {
			t.Fatalf("client_version = %q, want 0.144.0", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+forgeFakeCodexJWT(accountID) {
			t.Fatalf("Authorization = %q", got)
		}
		if got := r.Header.Get("ChatGPT-Account-Id"); got != accountID {
			t.Fatalf("ChatGPT-Account-Id = %q, want %q", got, accountID)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Fatalf("Accept = %q, want application/json", got)
		}
		if got := r.Header.Get("Accept-Encoding"); got != "identity" {
			t.Fatalf("Accept-Encoding = %q, want identity", got)
		}
		if got := r.Header.Get("Cookie"); got != "" {
			t.Fatalf("downstream Cookie leaked upstream: %q", got)
		}
		if got := r.Header.Get("Proxy-Authorization"); got != "" {
			t.Fatalf("downstream Proxy-Authorization leaked upstream: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `W/"models-56"`)
		_, _ = io.WriteString(w, `{"models":[{"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol"}]}`)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			if card != "codex-card" || deviceId != "device-a" || force {
				t.Fatalf("lease args card=%q deviceId=%q force=%v", card, deviceId, force)
			}
			return &CodexTokenLease{AccessToken: forgeFakeCodexJWT(accountID)}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.144.0", nil)
	req.Header.Set("Authorization", "Bearer local-fake-token")
	req.Header.Set("Cookie", "session=local-only")
	req.Header.Set("Proxy-Authorization", "Basic local-only")
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "direct")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"models":[{"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol"}]}` {
		t.Fatalf("body = %s", got)
	}
	if got := rec.Header().Get("ETag"); got != `W/"models-56"` {
		t.Fatalf("ETag = %q", got)
	}
}

func TestCodexModelsFallsBackToDiskCache(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	cache := `{"client_version":"0.144.0","etag":"disk-etag","models":[{"slug":"gpt-5.6-terra"}]}`
	if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(cache), 0o600); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: forgeFakeCodexJWT("acct-disk")}, nil
		},
	}
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.144.0", nil), "codex-card", "device-a", "direct")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != cache {
		t.Fatalf("body = %s, want disk cache", got)
	}
	if got := rec.Header().Get("ETag"); got != "disk-etag" {
		t.Fatalf("ETag = %q, want disk-etag", got)
	}
}

func TestCodexModelsFallsBackToEmptyCatalog(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: forgeFakeCodexJWT("acct-empty")}, nil
		},
	}
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil), "codex-card", "device-a", "direct")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"models":[]}` {
		t.Fatalf("body = %s, want empty Codex catalog", got)
	}
}

func TestCodexModelsCoalescesConcurrentRequestsWithoutCachingResult(t *testing.T) {
	var leaseCalls atomic.Int32
	var upstreamCalls atomic.Int32
	firstUpstreamEntered := make(chan struct{})
	releaseUpstream := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if upstreamCalls.Add(1) == 1 {
			close(firstUpstreamEntered)
		}
		<-releaseUpstream
		_, _ = io.WriteString(w, `{"models":[{"slug":"gpt-5.6-sol"}]}`)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			leaseCalls.Add(1)
			return &CodexTokenLease{AccessToken: forgeFakeCodexJWT("acct-shared")}, nil
		},
	}
	type response struct {
		code int
		body string
	}
	doRequest := func(done chan<- response) {
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.144.0", nil), "codex-card", "device-a", "direct")
		done <- response{code: rec.Code, body: strings.TrimSpace(rec.Body.String())}
	}

	done := make(chan response, 2)
	go doRequest(done)
	select {
	case <-firstUpstreamEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("first models request did not reach upstream")
	}
	go doRequest(done)
	time.Sleep(100 * time.Millisecond)
	close(releaseUpstream)
	for range 2 {
		select {
		case got := <-done:
			if got.code != http.StatusOK || got.body != `{"models":[{"slug":"gpt-5.6-sol"}]}` {
				t.Fatalf("response = status %d body %s", got.code, got.body)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("concurrent models request did not finish")
		}
	}
	if got := leaseCalls.Load(); got != 1 {
		t.Fatalf("concurrent lease calls = %d, want 1", got)
	}
	if got := upstreamCalls.Load(); got != 1 {
		t.Fatalf("concurrent upstream calls = %d, want 1", got)
	}

	third := httptest.NewRecorder()
	proxy.ServeHTTP(third, httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.144.0", nil), "codex-card", "device-a", "direct")
	if got := leaseCalls.Load(); got != 2 {
		t.Fatalf("sequential lease calls = %d, want 2 (completed result must not be cached)", got)
	}
	if got := upstreamCalls.Load(); got != 2 {
		t.Fatalf("sequential upstream calls = %d, want 2 (completed result must not be cached)", got)
	}
}

func TestCodexModelsSharedFetchSurvivesLeaderCancellation(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	entered := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-release:
			_, _ = io.WriteString(w, `{"models":[{"slug":"gpt-5.6-sol"}]}`)
		case <-r.Context().Done():
			return
		}
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: forgeFakeCodexJWT("acct-cancel")}, nil
		},
	}
	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderDone := make(chan struct{})
	go func() {
		defer close(leaderDone)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.144.0", nil).WithContext(leaderCtx)
		proxy.ServeHTTP(rec, req, "codex-card", "device-a", "direct")
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not reach upstream")
	}

	type response struct {
		code int
		body string
	}
	waiterDone := make(chan response, 1)
	go func() {
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.144.0", nil), "codex-card", "device-a", "direct")
		waiterDone <- response{code: rec.Code, body: strings.TrimSpace(rec.Body.String())}
	}()
	time.Sleep(100 * time.Millisecond)
	cancelLeader()
	time.Sleep(50 * time.Millisecond)
	close(release)

	select {
	case got := <-waiterDone:
		if got.code != http.StatusOK || got.body != `{"models":[{"slug":"gpt-5.6-sol"}]}` {
			t.Fatalf("waiter response after leader cancellation = status %d body %s", got.code, got.body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter did not finish")
	}
	select {
	case <-leaderDone:
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not finish")
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

// 快速档开 + 被租号 plan 支持(pro):Codex 自己不发 service_tier,代理注入 priority 到上游,
// 且用量上报带 ServiceTier=priority(供服务端按 fast 乘数扣份额)。
func TestCodexProxyInjectsFastServiceTierWhenEntitled(t *testing.T) {
	reported := make(chan ReportDetails, 1)
	var gotTier string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		_ = json.Unmarshal(body, &m)
		gotTier, _ = m["service_tier"].(string)
		codexUsageJSON(w)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		fastMode:     true, // 用户开了快速档
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: "tok", AccountId: 7, LeaseId: "lease-7", PlanType: "pro"}, nil
		},
		reportResult: func(card, deviceId string, d ReportDetails, up string, l *CodexTokenLease) { reported <- d },
	}
	// body 无 service_tier(Codex 自定义 provider 模式不发)→ 代理应注入。
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if gotTier != "priority" {
		t.Fatalf("上游收到 service_tier = %q, want priority(应注入)", gotTier)
	}
	select {
	case d := <-reported:
		if d.ServiceTier != "priority" {
			t.Fatalf("report ServiceTier = %q, want priority", d.ServiceTier)
		}
	default:
		t.Fatal("expected usage report")
	}
}

// 被租号 plan 不支持(plus)时,即便快速档开、body 自带 priority 也必须被剥掉,
// 且上报 ServiceTier 为空(按标准档计量)。
func TestCodexProxyStripsFastServiceTierWhenNotEntitled(t *testing.T) {
	reported := make(chan ReportDetails, 1)
	var hasTier bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		_ = json.Unmarshal(body, &m)
		_, hasTier = m["service_tier"]
		codexUsageJSON(w)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		fastMode:     true, // 快速档开,但下面的号是 plus 不支持
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: "tok", AccountId: 7, LeaseId: "lease-7", PlanType: "plus"}, nil
		},
		reportResult: func(card, deviceId string, d ReportDetails, up string, l *CodexTokenLease) { reported <- d },
	}
	// 客户端 body 自带 priority(模拟用户在自己 Codex 里开了 Fast)。
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi","service_tier":"priority"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if hasTier {
		t.Fatal("未授权时残留的 priority 应被剥掉,上游不应收到 service_tier")
	}
	select {
	case d := <-reported:
		if d.ServiceTier != "" {
			t.Fatalf("report ServiceTier = %q, want empty", d.ServiceTier)
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

// codexUsageJSON 是一个最小的 codex 生成响应(带 usage),供测试上游/代理返回。
func codexUsageJSON(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"id": "resp_1", "object": "response",
		"usage": map[string]int{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
	})
}

// 集成:租到的号带绑定出口代理时,生成请求必须经该代理出站(而非从本机直连上游)。
// upstreamBase 指向一个不可达地址,只有真正走了绑定代理才能拿到 200。
func TestCodexProxyRoutesGenerationThroughBoundEgressProxy(t *testing.T) {
	proxyHit := make(chan struct{}, 1)
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case proxyHit <- struct{}{}:
		default:
		}
		codexUsageJSON(w)
	}))
	defer proxySrv.Close()

	proxy := &CodexProxy{
		upstreamBase: "http://127.0.0.1:1", // 不可达:直连必失败,只有经代理才能成功
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{
				AccessToken: "codex-access-token", AccountId: 7, LeaseId: "lease-7",
				EgressInfo: EgressInfo{ProxyURL: proxySrv.URL, EgressRequired: false},
			}, nil
		},
		reportResult: func(card, deviceId string, d ReportDetails, up string, l *CodexTokenLease) {},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "direct")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	select {
	case <-proxyHit:
	default:
		t.Fatal("生成请求没有经过绑定出口代理")
	}
}

// 集成:绑定出口代理在传输层挂掉时,codex(optional)必须降级本机直连重试并成功。
func TestCodexProxyDegradesToLocalWhenBoundProxyFails(t *testing.T) {
	upstreamHit := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case upstreamHit <- struct{}{}:
		default:
		}
		codexUsageJSON(w)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			return &CodexTokenLease{
				AccessToken: "codex-access-token", AccountId: 7, LeaseId: "lease-7",
				EgressInfo: EgressInfo{ProxyURL: "http://127.0.0.1:1", EgressRequired: false}, // 死代理
			}, nil
		},
		reportResult: func(card, deviceId string, d ReportDetails, up string, l *CodexTokenLease) {},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "codex-card", "device-a", "direct") // userProxy="direct" → 降级走本机直连

	if rec.Code != http.StatusOK {
		t.Fatalf("降级后应 200,got %d body=%s", rec.Code, rec.Body.String())
	}
	select {
	case <-upstreamHit:
	default:
		t.Fatal("降级后没有打到本机直连的上游")
	}
}
