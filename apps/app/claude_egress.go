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
//   1. utls 伪装 ClientHello —— 让到 api.anthropic.com 的 TLS 指纹【逐字节】等于真
//      Claude Code(Node/undici over OpenSSL)。不是"挑个最接近的浏览器预设",而是按真
//      客户端实测的 ClientHello 手搓 spec(见 claudeCodeClientHelloSpec):cipher/扩展/
//      曲线/签名算法/顺序全对齐,连域名时 JA3=dc782a9d…、无 SNI 时 JA3=e97f5146…,与真
//      客户端一致 → 混入真实用户流量,不再是"全池统一却和真客户端不一样"的可聚类指纹。
//      (历史教训:曾用 Firefox 预设,带了 ECH 等 Firefox 专属扩展、ALPN 还得强降 http/1.1,
//       JA3 和真客户端对不上且全池一个值,正是被批量封号的破绽。)
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

// claudeCodeClientHelloSpec 返回【逐字节复刻真 Claude Code(claude-cli/2.x · Node/undici
// over OpenSSL)】的 utls ClientHelloSpec。cipher 套件、扩展类型与顺序、椭圆曲线、签名算法
// 全部按真客户端抓包结果排列;ALPN 只宣告 http/1.1(真客户端就是 http/1.1,不发 h2)。
//
// 校验(见 claude_egress_test.go + 一次性沙盒验证):
//   - 无 SNI(连 IP)时 JA3 = e97f5146a7009cc2918b50e903b6ff8d
//   - 含 SNI(连 api.anthropic.com)时 JA3 = dc782a9d905fdcee1223a3d4e8108bc6
//     两者均与真 claude-cli 实测一致;且该 spec 真连 api.anthropic.com 握手成功(返回 401)。
//
// 必须【每次拨号新建一个 spec】:KeyShareExtension 等在握手时会写入每连接的临时密钥,复用会串号。
func claudeCodeClientHelloSpec() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		TLSVersMin: utls.VersionTLS12,
		TLSVersMax: utls.VersionTLS13,
		CipherSuites: []uint16{
			utls.TLS_AES_128_GCM_SHA256,                        // 1301
			utls.TLS_AES_256_GCM_SHA384,                        // 1302
			utls.TLS_CHACHA20_POLY1305_SHA256,                  // 1303
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,       // c02b
			utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,         // c02f
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,       // c02c
			utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,         // c030
			utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, // cca9
			utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,   // cca8
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,          // c009
			utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,            // c013
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA,          // c00a
			utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,            // c014
			utls.TLS_RSA_WITH_AES_128_GCM_SHA256,               // 009c
			utls.TLS_RSA_WITH_AES_256_GCM_SHA384,               // 009d
			utls.TLS_RSA_WITH_AES_128_CBC_SHA,                  // 002f
			utls.TLS_RSA_WITH_AES_256_CBC_SHA,                  // 0035
		},
		CompressionMethods: []byte{0x00},
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{},                      // 0000 —— ServerName 由 utls 从 Config 自动填;连域名时放第一位(对齐 OpenSSL)
			&utls.UtlsExtendedMasterSecretExtension{}, // 0017
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},                       // ff01
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519, utls.CurveP256, utls.CurveP384}}, // 000a: 001d 0017 0018
			&utls.SupportedPointsExtension{SupportedPoints: []byte{0x00}},                                       // 000b: uncompressed
			&utls.SessionTicketExtension{},                           // 0023
			&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}}, // 0010: 真客户端只 http/1.1
			&utls.StatusRequestExtension{},                           // 0005
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{
				utls.ECDSAWithP256AndSHA256, // 0403
				utls.PSSWithSHA256,          // 0804
				utls.PKCS1WithSHA256,        // 0401
				utls.ECDSAWithP384AndSHA384, // 0503
				utls.PSSWithSHA384,          // 0805
				utls.PKCS1WithSHA384,        // 0501
				utls.PSSWithSHA512,          // 0806
				utls.PKCS1WithSHA512,        // 0601
				utls.PKCS1WithSHA1,          // 0201
			}},
			&utls.SCTExtension{}, // 0012
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519}}},                  // 0033
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},                        // 002d
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}}, // 002b
		},
	}
}

// newClaudeUpstreamTransport 构造到 api.anthropic.com 的 transport:
// DialTLSContext = (经代理的原始 TCP)+ utls 握手,ClientHello 由 claudeCodeClientHelloSpec
// 精确复刻真 Claude Code(只宣告 http/1.1,与真客户端一致;服务器据此选 1.1,本 transport 正常解析)。
func newClaudeUpstreamTransport(proxyURL string) *http.Transport {
	return newClaudeUpstreamTransportFn(func() string { return proxyURL })
}

// newClaudeUpstreamTransportFn 同 newClaudeUpstreamTransport,但出口代理【每次拨号时】由
// proxyFn 实时求值。供 claude.ai 借号场景:同一 transport 跟随当前租到的白号静态出口动态切换,
// 无需在租约变化时重建 handler。proxyFn 为 nil 或返回 "" → 直连。
func newClaudeUpstreamTransportFn(proxyFn func() string) *http.Transport {
	return &http.Transport{
		Proxy: nil, // 代理在 DialTLSContext 内处理,不走 Transport.Proxy。
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			proxyURL := ""
			if proxyFn != nil {
				proxyURL = proxyFn()
			}
			raw, err := dialRawThroughProxy(ctx, addr, proxyURL)
			if err != nil {
				return nil, err
			}
			host, _, splitErr := net.SplitHostPort(addr)
			if splitErr != nil {
				host = addr
			}
			// ClientHello 逐字节复刻真 Claude Code(见 claudeCodeClientHelloSpec)。
			// 每拨号新建 spec:KeyShare 等含每连接临时密钥,不可复用。
			spec := claudeCodeClientHelloSpec()
			conn := utls.UClient(raw, &utls.Config{ServerName: host}, utls.HelloCustom)
			if err := conn.ApplyPreset(spec); err != nil {
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
