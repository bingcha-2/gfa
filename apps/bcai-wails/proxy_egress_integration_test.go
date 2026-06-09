package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// withAntigravityLeaseBase 把全局 leaser 的 bcai 基址指向本地 mock,返回 cleanup。
func withAntigravityLeaseBase(t *testing.T, base string) {
	t.Helper()
	prev := API_BASE
	API_BASE = base
	t.Cleanup(func() { API_BASE = prev })
}

// withCloudEndpoints 改写 antigravity 的 cloudcode 上游为本地地址(测试用),返回 cleanup。
func withCloudEndpoints(t *testing.T, def, daily string) {
	t.Helper()
	pd, pdy := DefaultCloudEndpoint, DailyCloudEndpoint
	DefaultCloudEndpoint, DailyCloudEndpoint = def, daily
	t.Cleanup(func() { DefaultCloudEndpoint, DailyCloudEndpoint = pd, pdy })
}

func antigravityLeaseServer(t *testing.T, accountProxyUrl string, egressRequired bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/lease-token") {
			http.Error(w, "unexpected path", 404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":              true,
			"accessToken":     "g-access-token",
			"accountId":       5,
			"leaseId":         "lease-5",
			"projectId":       "proj-1",
			"accountProxyUrl": accountProxyUrl,
			"egressRequired":  egressRequired,
		})
	}))
}

// 集成:antigravity 生成请求必须经所租号绑定的出口代理出站。cloudcode 上游设为不可达,
// 只有真正走了绑定代理才能拿到 200。
func TestAntigravityRoutesGenerationThroughBoundEgressProxy(t *testing.T) {
	proxyHit := make(chan struct{}, 1)
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case proxyHit <- struct{}{}:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer proxySrv.Close()

	leaseSrv := antigravityLeaseServer(t, proxySrv.URL, false)
	defer leaseSrv.Close()
	withAntigravityLeaseBase(t, leaseSrv.URL)
	withCloudEndpoints(t, "http://127.0.0.1:1", "http://127.0.0.1:1") // 直连必失败

	p := &ProxyServer{}
	body := []byte(`{"model":"claude-sonnet-4-5","project":"proj-1","contents":[]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/cloudcode/generate", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	p.handleGenerationRequest(rec, req, body, "card-1", "dev-1", "direct", 1)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	select {
	case <-proxyHit:
	default:
		t.Fatal("antigravity 生成请求没有经过绑定出口代理")
	}
}

// 集成:绑定出口代理传输层失败时,antigravity(optional)降级本机直连重试并成功。
func TestAntigravityDegradesToLocalWhenBoundProxyFails(t *testing.T) {
	upstreamHit := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case upstreamHit <- struct{}{}:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	leaseSrv := antigravityLeaseServer(t, "http://127.0.0.1:1", false) // 绑定代理死
	defer leaseSrv.Close()
	withAntigravityLeaseBase(t, leaseSrv.URL)
	withCloudEndpoints(t, upstream.URL, upstream.URL) // 本机直连可达

	p := &ProxyServer{}
	body := []byte(`{"model":"claude-sonnet-4-5","project":"proj-1","contents":[]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/cloudcode/generate", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	p.handleGenerationRequest(rec, req, body, "card-1", "dev-1", "direct", 1)

	if rec.Code != http.StatusOK {
		t.Fatalf("降级后应 200,got %d body=%s", rec.Code, rec.Body.String())
	}
	select {
	case <-upstreamHit:
	default:
		t.Fatal("降级后没有打到本机直连的上游")
	}
}
