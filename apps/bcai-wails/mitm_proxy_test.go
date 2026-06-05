package main

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 端到端验证 MITM 管道：客户端把根 CA 当受信任根，经本地代理 CONNECT 访问
// https://api.anthropic.com/v1/messages —— 代理应用叶证书终止 TLS、解密出请求、
// 交给注入的 handler，并把响应原样回传。全程不触外网。
func TestMitmProxyInterceptsAndDispatches(t *testing.T) {
	root, err := mitmEnsureRootAt(t.TempDir())
	if err != nil {
		t.Fatalf("ensure root: %v", err)
	}

	var gotMethod, gotHost, gotPath, gotBody string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotHost = r.Host
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":"mitm"}`))
	})

	p := newMitmProxy(mitmNewLeafCache(root), handler)
	if err := p.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("proxy start: %v", err)
	}
	defer p.Stop()

	proxyURL, _ := url.Parse("http://" + p.Addr())
	pool := x509.NewCertPool()
	pool.AddCert(root.Certificate)
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{RootCAs: pool},
		},
	}

	resp, err := client.Post("https://api.anthropic.com/v1/messages",
		"application/json", strings.NewReader(`{"hi":1}`))
	if err != nil {
		t.Fatalf("request through MITM proxy failed: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 || string(body) != `{"ok":"mitm"}` {
		t.Fatalf("unexpected response: %d %q", resp.StatusCode, string(body))
	}
	if gotMethod != "POST" || gotHost != "api.anthropic.com" || gotPath != "/v1/messages" {
		t.Fatalf("handler saw wrong request: %s %s %s", gotMethod, gotHost, gotPath)
	}
	if gotBody != `{"hi":1}` {
		t.Fatalf("handler saw wrong body: %q", gotBody)
	}
}
