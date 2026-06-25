package main

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	utls "github.com/refraction-networking/utls"
)

// TestClaudeCodeClientHelloSpec 锁住出口 ClientHello 指纹:必须逐字节对齐真 Claude Code
// (Node/undici)。任何对 cipher 顺序、扩展、曲线、ALPN 的改动都会改变 JA3、让全池流量重新
// 可被聚类封号,故在此硬性回归。期望值来自真 claude-cli 实测(无 SNI JA3=e97f5146…)。
func TestClaudeCodeClientHelloSpec(t *testing.T) {
	spec := claudeCodeClientHelloSpec()

	wantCiphers := []uint16{
		utls.TLS_AES_128_GCM_SHA256, utls.TLS_AES_256_GCM_SHA384, utls.TLS_CHACHA20_POLY1305_SHA256,
		utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		utls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
		utls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
		utls.TLS_RSA_WITH_AES_128_GCM_SHA256, utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_RSA_WITH_AES_128_CBC_SHA, utls.TLS_RSA_WITH_AES_256_CBC_SHA,
	}
	if len(spec.CipherSuites) != len(wantCiphers) {
		t.Fatalf("cipher 数量 = %d, want %d", len(spec.CipherSuites), len(wantCiphers))
	}
	for i := range wantCiphers {
		if spec.CipherSuites[i] != wantCiphers[i] {
			t.Errorf("cipher[%d] = 0x%04x, want 0x%04x(顺序也必须一致)", i, spec.CipherSuites[i], wantCiphers[i])
		}
	}

	// 第一个扩展必须是 SNI(对齐 OpenSSL 连域名时的顺序)。
	if _, ok := spec.Extensions[0].(*utls.SNIExtension); !ok {
		t.Errorf("第一个扩展应为 SNIExtension,实际 %T", spec.Extensions[0])
	}

	// ALPN 必须只宣告 http/1.1;一旦混入 h2,服务器会选 HTTP/2、且偏离真客户端。
	var foundALPN bool
	for _, ext := range spec.Extensions {
		if alpn, ok := ext.(*utls.ALPNExtension); ok {
			foundALPN = true
			if len(alpn.AlpnProtocols) != 1 || alpn.AlpnProtocols[0] != "http/1.1" {
				t.Errorf("ALPN = %v, want [http/1.1]", alpn.AlpnProtocols)
			}
		}
	}
	if !foundALPN {
		t.Error("缺少 ALPN 扩展")
	}

	// 曲线必须正好 X25519 / P256 / P384(真客户端只这三条;多了就偏离指纹)。
	wantCurves := []utls.CurveID{utls.X25519, utls.CurveP256, utls.CurveP384}
	var foundCurves bool
	for _, ext := range spec.Extensions {
		if c, ok := ext.(*utls.SupportedCurvesExtension); ok {
			foundCurves = true
			if len(c.Curves) != len(wantCurves) {
				t.Fatalf("曲线数量 = %d, want %d", len(c.Curves), len(wantCurves))
			}
			for i := range wantCurves {
				if c.Curves[i] != wantCurves[i] {
					t.Errorf("曲线[%d] = 0x%04x, want 0x%04x", i, c.Curves[i], wantCurves[i])
				}
			}
		}
	}
	if !foundCurves {
		t.Error("缺少 SupportedCurves 扩展")
	}

	// 每次必须是新实例(KeyShare 含每连接密钥,复用会串号)。
	if spec == claudeCodeClientHelloSpec() {
		t.Error("claudeCodeClientHelloSpec 应每次返回新实例")
	}
}

func TestParseEgressProxy(t *testing.T) {
	cases := []struct {
		in      string
		scheme  string
		wantErr bool
	}{
		{"", "", false},
		{"  ", "", false},
		{"socks5://user:pass@host:1080", "socks5", false},
		{"http://host:8080", "http", false},
		{"https://host:8443", "https", false},
		{"ftp://nope", "", true},
		{"://bad", "", true},
	}
	for _, c := range cases {
		scheme, _, err := parseEgressProxy(c.in)
		if c.wantErr && err == nil {
			t.Errorf("parseEgressProxy(%q) expected error", c.in)
		}
		if !c.wantErr && err != nil {
			t.Errorf("parseEgressProxy(%q) unexpected error: %v", c.in, err)
		}
		if !c.wantErr && scheme != c.scheme {
			t.Errorf("parseEgressProxy(%q) scheme = %q, want %q", c.in, scheme, c.scheme)
		}
	}
}

func TestDialRawThroughProxyDirect(t *testing.T) {
	// With no proxy, dialRawThroughProxy连直连目标。起一个本地 echo TCP server。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = conn.Write([]byte("hi"))
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dialRawThroughProxy(ctx, ln.Addr().String(), "")
	if err != nil {
		t.Fatalf("dialRawThroughProxy direct: %v", err)
	}
	defer conn.Close()
	buf := make([]byte, 2)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "hi" {
		t.Fatalf("got %q want hi", string(buf))
	}
}

func TestNewClaudeUpstreamClientBuilds(t *testing.T) {
	// 直连(无代理)与 socks5 代理都应能构造出 client(不实际连)。
	if c := newClaudeUpstreamClient(""); c == nil || c.Transport == nil {
		t.Fatal("direct client should build")
	}
	if c := newClaudeUpstreamClient("socks5://127.0.0.1:1080"); c == nil || c.Transport == nil {
		t.Fatal("socks5 client should build")
	}
}
