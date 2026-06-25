package main

// 指纹漂移自检(方案 B)。不进常规测试,仅在 VERIFY_FP=1 时运行。
//
// 跑法(Claude Code 升级后跑一下,30 秒出结果):
//
//	VERIFY_FP=1 go test -run TestClaudeFingerprintDrift -count=1 -v ./
//	或直接:  bash scripts/verify-claude-fingerprint.sh
//
// 原理:本进程内起一个 TLS 抓取服务(解析 ClientHello 出 JA3),然后
//   1) 用【生产出口 client】(newClaudeUpstreamClient)打它一次 → 我们当前 spec 的 JA3;
//   2) exec 本机真 `claude -p hi`(经 ANTHROPIC_BASE_URL 指向抓取服务)→ 真客户端 JA3;
// 两者都连 127.0.0.1(IP,均不发 SNI),所以是 apples-to-apples 的"无 SNI JA3"比对。
//   - 一致 → PASS,spec 仍贴合真客户端;
//   - 不一致 → FAIL,并打印两边的 cipher/扩展/曲线明细,照着真客户端那列更新
//     claudeCodeClientHelloSpec 即可。

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/md5"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ── 抓取连接:记录首个 TLS 记录(ClientHello)──
type fpCaptureConn struct {
	net.Conn
	buf      bytes.Buffer
	captured bool
}

func (c *fpCaptureConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if !c.captured && n > 0 {
		c.buf.Write(p[:n])
		b := c.buf.Bytes()
		if len(b) >= 5 {
			recLen := int(b[3])<<8 | int(b[4])
			if c.buf.Len() >= recLen+5 {
				c.captured = true
			}
		}
	}
	return n, err
}

type fpCapListener struct{ net.Listener }

func (l fpCapListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &fpCaptureConn{Conn: c}, nil
}

type fpHello struct {
	ja3        string
	ciphers    []uint16
	extensions []uint16
	curves     []uint16
}

func fpIsGREASE(v uint16) bool { return v&0x0f0f == 0x0a0a && byte(v>>8) == byte(v) }

func fpParseClientHello(raw []byte) (*fpHello, error) {
	if len(raw) < 5 || raw[0] != 0x16 {
		return nil, fmt.Errorf("不是 TLS handshake")
	}
	b := raw[5:]
	if len(b) < 4 || b[0] != 0x01 {
		return nil, fmt.Errorf("不是 ClientHello")
	}
	hsLen := int(b[1])<<16 | int(b[2])<<8 | int(b[3])
	b = b[4:]
	if len(b) > hsLen {
		b = b[:hsLen]
	}
	if len(b) < 2 {
		return nil, fmt.Errorf("截断")
	}
	legacy := uint16(b[0])<<8 | uint16(b[1])
	b = b[2:]
	if len(b) < 32+1 {
		return nil, fmt.Errorf("截断")
	}
	b = b[32:]
	sidLen := int(b[0])
	b = b[1:]
	if len(b) < sidLen+2 {
		return nil, fmt.Errorf("截断")
	}
	b = b[sidLen:]
	csLen := int(b[0])<<8 | int(b[1])
	b = b[2:]
	if len(b) < csLen+1 {
		return nil, fmt.Errorf("截断")
	}
	h := &fpHello{}
	for i := 0; i+1 < csLen; i += 2 {
		h.ciphers = append(h.ciphers, uint16(b[i])<<8|uint16(b[i+1]))
	}
	b = b[csLen:]
	compLen := int(b[0])
	b = b[1:]
	if len(b) < compLen {
		return nil, fmt.Errorf("截断")
	}
	b = b[compLen:]
	var points []uint8
	if len(b) >= 2 {
		extTotal := int(b[0])<<8 | int(b[1])
		b = b[2:]
		if len(b) > extTotal {
			b = b[:extTotal]
		}
		for len(b) >= 4 {
			et := uint16(b[0])<<8 | uint16(b[1])
			el := int(b[2])<<8 | int(b[3])
			b = b[4:]
			if len(b) < el {
				break
			}
			data := b[:el]
			b = b[el:]
			h.extensions = append(h.extensions, et)
			switch et {
			case 0x000a:
				if len(data) >= 2 {
					ll := int(data[0])<<8 | int(data[1])
					d := data[2:]
					if len(d) > ll {
						d = d[:ll]
					}
					for i := 0; i+1 < len(d); i += 2 {
						h.curves = append(h.curves, uint16(d[i])<<8|uint16(d[i+1]))
					}
				}
			case 0x000b:
				if len(data) >= 1 {
					ll := int(data[0])
					d := data[1:]
					if len(d) > ll {
						d = d[:ll]
					}
					points = append(points, d...)
				}
			}
		}
	}
	join := func(xs []uint16) string {
		ss := make([]string, len(xs))
		for i, x := range xs {
			ss[i] = strconv.Itoa(int(x))
		}
		return strings.Join(ss, "-")
	}
	pf := make([]string, len(points))
	for i, x := range points {
		pf[i] = strconv.Itoa(int(x))
	}
	s := fmt.Sprintf("%d,%s,%s,%s,%s", legacy, join(h.ciphers), join(h.extensions), join(h.curves), strings.Join(pf, "-"))
	h.ja3 = fmt.Sprintf("%x", md5.Sum([]byte(s)))
	return h, nil
}

func fpHexList(xs []uint16) string {
	ss := make([]string, 0, len(xs))
	for _, x := range xs {
		if fpIsGREASE(x) {
			ss = append(ss, "GREASE")
		} else {
			ss = append(ss, fmt.Sprintf("0x%04x", x))
		}
	}
	return strings.Join(ss, " ")
}

func fpGenCert() tls.Certificate {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "fpverify"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	c, _ := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
	)
	return c
}

func TestClaudeFingerprintDrift(t *testing.T) {
	if os.Getenv("VERIFY_FP") != "1" {
		t.Skip("指纹自检:设 VERIFY_FP=1 运行(需本机装有 claude)")
	}
	claudePath, err := exec.LookPath("claude")
	if err != nil {
		t.Skip("PATH 里没有 claude,跳过(在装了 Claude Code 的机器上跑)")
	}

	// 每次握手解析出的 JA3 推进 channel;按阶段取。
	captured := make(chan *fpHello, 16)
	cfg := &tls.Config{
		Certificates: []tls.Certificate{fpGenCert()},
		NextProtos:   []string{"h2", "http/1.1"},
		MinVersion:   tls.VersionTLS10,
		GetConfigForClient: func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
			if cc, ok := chi.Conn.(*fpCaptureConn); ok {
				if h, perr := fpParseClientHello(cc.buf.Bytes()); perr == nil {
					select {
					case captured <- h:
					default:
					}
				}
			}
			return nil, nil
		},
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	base := fmt.Sprintf("https://127.0.0.1:%d", port)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	}), TLSConfig: cfg}
	go func() { _ = srv.ServeTLS(fpCapListener{ln}, "", "") }()
	defer srv.Close()

	drain := func() { // 清掉残留,保证每阶段取到的是本阶段的握手
		for {
			select {
			case <-captured:
			default:
				return
			}
		}
	}

	// 阶段 1:生产出口 client 打一次 → 我们 spec 的 JA3。
	drain()
	_, _ = newClaudeUpstreamClient("").Get(base + "/v1/messages") // 证书校验会失败,但 ClientHello 已被抓
	var specHello *fpHello
	select {
	case specHello = <-captured:
	case <-time.After(8 * time.Second):
		t.Fatal("没抓到生产 client 的 ClientHello")
	}

	// 阶段 2:真 claude 打一次 → 真客户端 JA3。
	drain()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, claudePath, "-p", "hi")
	cmd.Env = append(os.Environ(),
		"NODE_TLS_REJECT_UNAUTHORIZED=0",
		"ANTHROPIC_BASE_URL="+base,
		"ANTHROPIC_API_KEY=sk-ant-verify",
		"ANTHROPIC_AUTH_TOKEN=sk-ant-verify",
	)
	go func() { _ = cmd.Run() }() // 退出码/输出不关心,只要它发出 ClientHello
	var realHello *fpHello
	select {
	case realHello = <-captured:
	case <-time.After(35 * time.Second):
		t.Fatal("没抓到 claude 的 ClientHello(它可能没把请求打到 ANTHROPIC_BASE_URL)")
	}

	t.Logf("生产 spec JA3 : %s", specHello.ja3)
	t.Logf("真 claude JA3 : %s  (%s)", realHello.ja3, claudePath)

	if specHello.ja3 == realHello.ja3 {
		t.Logf("✅ 指纹一致,无需更新 claudeCodeClientHelloSpec")
		return
	}
	t.Errorf("❌ 指纹漂移!生产 spec 与真 Claude Code 不一致,需更新 claude_egress.go 的 claudeCodeClientHelloSpec")
	t.Errorf("  cipher 真客户端 : %s", fpHexList(realHello.ciphers))
	t.Errorf("  cipher 当前spec : %s", fpHexList(specHello.ciphers))
	t.Errorf("  扩展   真客户端 : %s", fpHexList(realHello.extensions))
	t.Errorf("  扩展   当前spec : %s", fpHexList(specHello.extensions))
	t.Errorf("  曲线   真客户端 : %s", fpHexList(realHello.curves))
	t.Errorf("  曲线   当前spec : %s", fpHexList(specHello.curves))
	t.Errorf("  → 照「真客户端」那几列更新 spec 后重跑本检查至 ✅")
}
