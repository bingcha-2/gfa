package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	xproxy "golang.org/x/net/proxy"
)

// ─── Claude 出口层(utls TLS 指纹 + 每号粘性住宅代理)──────────────────────────
//
// 对照 reclaude internal/fingerprint + internal/proxyroute。两个目的:
//   1. utls 伪装 ClientHello —— 让到 api.anthropic.com 的 TLS 指纹看起来像 Node.js
//      运行时(Claude Code 的真实 runtime),消除 Go 标准库直连的 JA3/JA4 不匹配。
//      Node.js 用 OpenSSL,utls 里最接近的预设是 Firefox(同 OpenSSL 系)。
//   2. 每号粘性代理 —— 同一个 Claude 订阅号的出口固定走一个住宅/移动代理 IP,
//      避免"一个机房 IP 挂 N 个号 / 同号多地登录"的聚类与不可能旅行信号。
//      代理 URL 由服务端按租到的账号下发(claudeProxyUrl),客户端据此路由该跳。
//
// 与 reclaude 的差异:reclaude 是 MITM 逐字转发,出口层在它自己的本地代理里;
// 我们注入 base_url 后,出口层在 claude_proxy 转发 api.anthropic.com 那一跳生效。

// parseEgressProxy 校验并拆出代理的 scheme(""=直连)。支持 http/https/socks5。
func parseEgressProxy(raw string) (scheme string, u *url.URL, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil, nil
	}
	u, err = url.Parse(raw)
	if err != nil {
		return "", nil, err
	}
	scheme = strings.ToLower(u.Scheme)
	switch scheme {
	case "http", "https", "socks5", "socks5h":
		if u.Host == "" {
			return "", nil, fmt.Errorf("代理 URL 缺少 host: %q", raw)
		}
		return scheme, u, nil
	default:
		return "", nil, fmt.Errorf("不支持的代理协议 %q(仅 http/https/socks5)", scheme)
	}
}

// dialRawThroughProxy 建立到 addr 的原始 TCP 连接,proxyURL 非空时经代理:
// socks5 用 x/net/proxy;http(s) 用 CONNECT(复用 ConnectViaProxy)。空=直连。
func dialRawThroughProxy(ctx context.Context, addr string, proxyURL string) (net.Conn, error) {
	scheme, u, err := parseEgressProxy(proxyURL)
	if err != nil {
		return nil, err
	}
	if scheme == "" {
		d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
		return d.DialContext(ctx, "tcp", addr)
	}

	if scheme == "socks5" || scheme == "socks5h" {
		var auth *xproxy.Auth
		if u.User != nil {
			pw, _ := u.User.Password()
			auth = &xproxy.Auth{User: u.User.Username(), Password: pw}
		}
		d, derr := xproxy.SOCKS5("tcp", u.Host, auth, &net.Dialer{Timeout: 30 * time.Second})
		if derr != nil {
			return nil, derr
		}
		if cd, ok := d.(xproxy.ContextDialer); ok {
			return cd.DialContext(ctx, "tcp", addr)
		}
		return d.Dial("tcp", addr)
	}

	// http / https 代理:CONNECT 隧道。
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, _ := strconv.Atoi(portStr)
	return ConnectViaProxy(proxyURL, host, port, 30*time.Second)
}

// newClaudeUpstreamTransport 构造到 api.anthropic.com 的 transport:
// DialTLSContext = (经代理的原始 TCP)+ utls Firefox(≈Node)握手,并【强制 ALPN 只剩
// http/1.1】。
//
// 关键坑(对照 reclaude 的 chromeHTTPClient):光设 DialTLSContext 只能让 Go 客户端不主动
// 发起 h2,但 Firefox 预设的 ALPN 仍向服务器宣告 h2 → 服务器选 HTTP/2 回二进制帧,而本
// transport 按 HTTP/1.1 解析 → "malformed HTTP response"。所以必须把 ALPN 扩展改成只剩
// http/1.1,逼服务器走 1.1。指纹其余部分保持 Firefox。
func newClaudeUpstreamTransport(proxyURL string) *http.Transport {
	return &http.Transport{
		Proxy: nil, // 代理在 DialTLSContext 内处理,不走 Transport.Proxy。
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			raw, err := dialRawThroughProxy(ctx, addr, proxyURL)
			if err != nil {
				return nil, err
			}
			host, _, splitErr := net.SplitHostPort(addr)
			if splitErr != nil {
				host = addr
			}
			// 取 Firefox 预设的 ClientHello spec,把 ALPN 改成只 http/1.1 后再握手。
			spec, specErr := utls.UTLSIdToSpec(utls.HelloFirefox_Auto)
			if specErr != nil {
				raw.Close()
				return nil, fmt.Errorf("utls spec: %w", specErr)
			}
			for i, ext := range spec.Extensions {
				if alpn, ok := ext.(*utls.ALPNExtension); ok {
					alpn.AlpnProtocols = []string{"http/1.1"}
					spec.Extensions[i] = alpn
				}
			}
			conn := utls.UClient(raw, &utls.Config{ServerName: host}, utls.HelloCustom)
			if err := conn.ApplyPreset(&spec); err != nil {
				raw.Close()
				return nil, fmt.Errorf("utls apply preset: %w", err)
			}
			if err := conn.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, err
			}
			return conn, nil
		},
		// 响应头超时:流式请求里 header(200 + text/event-stream)在 thinking 之前就下发,
		// 不需要等到首字节,所以 60s 足够;调小是为了让"卡在上游连接"的请求快速失败、
		// 暴露问题,而不是干等 3 分钟。流式 body 的耗时由请求 context 控制,不受此限。
		ResponseHeaderTimeout:  60 * time.Second,
		MaxIdleConns:           100,
		IdleConnTimeout:        90 * time.Second,
		DisableCompression:     true,
		MaxResponseHeaderBytes: 0,
	}
}

// newClaudeUpstreamClient 出口 client:utls 指纹 + 可选粘性代理。无全局超时
// (SSE 流式由请求 context 控制)。
func newClaudeUpstreamClient(proxyURL string) *http.Client {
	return &http.Client{
		Timeout:   0,
		Transport: newClaudeUpstreamTransport(proxyURL),
	}
}
