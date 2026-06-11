package main

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	tls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

// ─── Codex egress uTLS(Chrome 指纹)──────────────────────────────────────────
//
// 对照 cockpit helps/utls_client.go:号池转发到 chatgpt.com 的 /responses 时,用
// utls 伪装成 Chrome 的 TLS 指纹 + HTTP/2,绕过 Cloudflare 对非浏览器 TLS 指纹的拦截。
// Go 默认 TLS 栈的 JA3 一眼可辨,号池高频多账号场景尤其容易被盯上。
//
// 仅对受保护域名(chatgpt.com)走 uTLS;其余(第三方中转站等)回退到标准 transport。
// WebSocket 路径不走 uTLS(对齐 cockpit:WS 用标准 gorilla dialer,避免 ALPN 协商出
// h2 导致 WS 握手失败)。

// codexUtlsProtectedHosts:需要 Chrome TLS 指纹的域名。
var codexUtlsProtectedHosts = map[string]struct{}{
	"chatgpt.com":     {},
	"www.chatgpt.com": {},
}

func isCodexUtlsProtectedHost(host string) bool {
	_, ok := codexUtlsProtectedHosts[strings.ToLower(host)]
	return ok
}

// codexUtlsRoundTripper 用 utls + Chrome 指纹实现 http.RoundTripper,按 host 复用 h2 连接。
type codexUtlsRoundTripper struct {
	mu          sync.Mutex
	connections map[string]*http2.ClientConn
	pending     map[string]*sync.Cond
	dialer      proxy.Dialer
}

func newCodexUtlsRoundTripper(proxyURL string) *codexUtlsRoundTripper {
	return &codexUtlsRoundTripper{
		connections: make(map[string]*http2.ClientConn),
		pending:     make(map[string]*sync.Cond),
		dialer:      buildCodexProxyDialer(proxyURL),
	}
}

func (t *codexUtlsRoundTripper) getOrCreateConnection(host, addr string) (*http2.ClientConn, error) {
	t.mu.Lock()
	if h2Conn, ok := t.connections[host]; ok && h2Conn.CanTakeNewRequest() {
		t.mu.Unlock()
		return h2Conn, nil
	}
	if cond, ok := t.pending[host]; ok {
		cond.Wait()
		if h2Conn, ok := t.connections[host]; ok && h2Conn.CanTakeNewRequest() {
			t.mu.Unlock()
			return h2Conn, nil
		}
	}
	cond := sync.NewCond(&t.mu)
	t.pending[host] = cond
	t.mu.Unlock()

	h2Conn, err := t.createConnection(host, addr)

	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.pending, host)
	cond.Broadcast()
	if err != nil {
		return nil, err
	}
	t.connections[host] = h2Conn
	return h2Conn, nil
}

func (t *codexUtlsRoundTripper) createConnection(host, addr string) (*http2.ClientConn, error) {
	conn, err := t.dialer.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	tlsConn := tls.UClient(conn, &tls.Config{ServerName: host}, tls.HelloChrome_Auto)
	if err := tlsConn.Handshake(); err != nil {
		conn.Close()
		return nil, err
	}
	tr := &http2.Transport{}
	h2Conn, err := tr.NewClientConn(tlsConn)
	if err != nil {
		tlsConn.Close()
		return nil, err
	}
	return h2Conn, nil
}

func (t *codexUtlsRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	hostname := req.URL.Hostname()
	port := req.URL.Port()
	if port == "" {
		port = "443"
	}
	addr := net.JoinHostPort(hostname, port)

	h2Conn, err := t.getOrCreateConnection(hostname, addr)
	if err != nil {
		return nil, err
	}
	resp, err := h2Conn.RoundTrip(req)
	if err != nil {
		// 连接坏了:从池里剔除,下次重建。
		t.mu.Lock()
		if cached, ok := t.connections[hostname]; ok && cached == h2Conn {
			delete(t.connections, hostname)
		}
		t.mu.Unlock()
		return nil, err
	}
	return resp, nil
}

// codexFallbackRoundTripper:受保护域名走 uTLS,其余走标准 transport。
type codexFallbackRoundTripper struct {
	utls     http.RoundTripper
	fallback http.RoundTripper
}

func (f *codexFallbackRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme == "https" && isCodexUtlsProtectedHost(req.URL.Hostname()) {
		return f.utls.RoundTrip(req)
	}
	return f.fallback.RoundTrip(req)
}

// createCodexStreamingHttpClient 为 codex 生成请求构建流式 client:发往 chatgpt.com 的
// 走 uTLS(Chrome 指纹 + h2),发往第三方中转站的走标准 transport。无全局超时(由
// proxy 的流计时器控制)。
func createCodexStreamingHttpClient(upstreamProxy string) *http.Client {
	effProxy := resolveCodexEffectiveProxy(upstreamProxy)

	utlsRT := newCodexUtlsRoundTripper(effProxy)

	fallback := newTransport()
	fallback.ResponseHeaderTimeout = 180 * time.Second // 与原 createStreamingHttpClient 一致
	if effProxy != "" {
		if proxyURL, err := url.Parse(effProxy); err == nil {
			fallback.Proxy = http.ProxyURL(proxyURL)
		}
	}

	return &http.Client{
		Timeout: 0,
		Transport: &codexFallbackRoundTripper{
			utls:     utlsRT,
			fallback: fallback,
		},
	}
}

// resolveCodexEffectiveProxy 复刻 createStreamingHttpClient 的代理优先级:
// 用户显式上游代理 > 系统代理 > 直连。返回代理 URL 字符串(直连返回 "")。
func resolveCodexEffectiveProxy(upstreamProxy string) string {
	upstreamProxy = strings.TrimSpace(upstreamProxy)
	if upstreamProxy != "" && !isDirectProxyMode(upstreamProxy) {
		return upstreamProxy
	}
	if upstreamProxy == "" {
		if sys := getSystemProxy(); sys != "" {
			return sys
		}
	}
	return ""
}

// buildCodexProxyDialer 把代理 URL 转成 uTLS 拨号用的 proxy.Dialer:
// 直连 → proxy.Direct;socks5 → proxy.SOCKS5;http/https → HTTP CONNECT 隧道。
func buildCodexProxyDialer(proxyURL string) proxy.Dialer {
	proxyURL = strings.TrimSpace(proxyURL)
	if proxyURL == "" || isDirectProxyMode(proxyURL) {
		return proxy.Direct
	}
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return proxy.Direct
	}
	switch strings.ToLower(parsed.Scheme) {
	case "socks5", "socks5h":
		var auth *proxy.Auth
		if parsed.User != nil {
			user := parsed.User.Username()
			pass, _ := parsed.User.Password()
			auth = &proxy.Auth{User: user, Password: pass}
		}
		d, errSocks := proxy.SOCKS5("tcp", parsed.Host, auth, proxy.Direct)
		if errSocks != nil {
			return proxy.Direct
		}
		return d
	case "http", "https":
		return &codexHTTPConnectDialer{proxyURL: parsed, forward: &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}}
	default:
		return proxy.Direct
	}
}

// codexHTTPConnectDialer 通过 HTTP 代理用 CONNECT 建隧道,供 uTLS 在隧道上做握手。
// golang.org/x/net/proxy 不支持 http 代理,故自实现(GFA 系统代理多为 Clash/Mihomo 的 http)。
type codexHTTPConnectDialer struct {
	proxyURL *url.URL
	forward  *net.Dialer
}

func (d *codexHTTPConnectDialer) Dial(network, addr string) (net.Conn, error) {
	conn, err := d.forward.Dial(network, d.proxyURL.Host)
	if err != nil {
		return nil, err
	}
	req := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: addr},
		Host:   addr,
		Header: make(http.Header),
	}
	if d.proxyURL.User != nil {
		user := d.proxyURL.User.Username()
		pass, _ := d.proxyURL.User.Password()
		token := base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
		req.Header.Set("Proxy-Authorization", "Basic "+token)
	}
	if err := req.Write(conn); err != nil {
		conn.Close()
		return nil, err
	}
	// CONNECT 的 2xx 响应无 body,ReadResponse 读完头即停,不会吞掉后续隧道字节。
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		conn.Close()
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		conn.Close()
		return nil, fmt.Errorf("codex utls: proxy CONNECT to %s failed: %s", addr, resp.Status)
	}
	return conn, nil
}
