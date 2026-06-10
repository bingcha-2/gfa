package main

import (
	"bufio"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

// ─── Claude 桌面端接管：MITM 代理服务 ───────────────────────────────────────
//
// 监听本地端口，作为 HTTP CONNECT 代理。对 mitmShouldIntercept 命中的域名
// (api.anthropic.com)：用根 CA 现签的叶证书终止 TLS，把解密出的明文连接喂给一个
// 内部 http.Server（它会自动用叶证书完成握手并解密），由注入的 handler 分派
// (/v1/messages→复用 ClaudeProxy 换号；其余透传)。其余域名：直接 splice 透传。
//
// 把 *tls.Conn 喂给 http.Server.Serve 是关键：net/http 会识别 *tls.Conn 并自动
// 握手、记录 TLS 状态，从而天然支持 HTTP/1.1 keep-alive、chunked、SSE 流式回传。

type mitmProxy struct {
	leafCache *mitmLeafCache
	handler   http.Handler

	mu       sync.Mutex
	listener net.Listener
	httpSrv  *http.Server
	feed     *mitmConnFeed
	running  bool
}

func newMitmProxy(leafCache *mitmLeafCache, handler http.Handler) *mitmProxy {
	return &mitmProxy{leafCache: leafCache, handler: handler}
}

func (p *mitmProxy) Start(addr string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return nil
	}
	ln, err := listenWithReclaim(addr)
	if err != nil {
		return err
	}
	p.listener = ln
	p.feed = newMitmConnFeed(ln.Addr())
	p.httpSrv = &http.Server{Handler: p.handler}
	p.running = true

	go func() { _ = p.httpSrv.Serve(p.feed) }()
	go p.acceptLoop(ln)
	return nil
}

func (p *mitmProxy) Addr() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.listener == nil {
		return ""
	}
	return p.listener.Addr().String()
}

func (p *mitmProxy) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running {
		return
	}
	p.running = false
	if p.listener != nil {
		_ = p.listener.Close()
	}
	if p.feed != nil {
		p.feed.Close()
	}
	if p.httpSrv != nil {
		_ = p.httpSrv.Close()
	}
}

func (p *mitmProxy) acceptLoop(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go p.handleConn(c)
	}
}

func (p *mitmProxy) handleConn(c net.Conn) {
	br := bufio.NewReader(c)
	req, err := http.ReadRequest(br)
	if err != nil {
		_ = c.Close()
		return
	}

	if req.Method != http.MethodConnect {
		// Code/Cowork 走 HTTPS，几乎只会是 CONNECT；非 CONNECT 暂不处理。
		_ = c.Close()
		return
	}

	host := mitmHostOnly(req.Host)
	if _, err := c.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		_ = c.Close()
		return
	}

	if !mitmShouldIntercept(host) {
		p.passthrough(c, req.Host)
		return
	}

	leaf, err := p.leafCache.GetTLSCert(host)
	if err != nil {
		Log("[mitm-proxy] leaf cert error for %s: %v", host, err)
		_ = c.Close()
		return
	}
	tlsConn := tls.Server(c, &tls.Config{
		Certificates: []tls.Certificate{*leaf},
		NextProtos:   []string{"http/1.1"}, // 强制 HTTP/1.1，避免 h2 复杂度
	})
	// 不在此显式握手：交给 http.Server，它识别 *tls.Conn 后会自动握手并解密。
	p.feed.push(tlsConn)
}

// passthrough 直连真实 upstream 并双向转发（不解密）。
func (p *mitmProxy) passthrough(client net.Conn, hostPort string) {
	upstream, err := net.DialTimeout("tcp", hostPort, 10*time.Second)
	if err != nil {
		_ = client.Close()
		return
	}
	mitmBidiSplice(client, upstream)
}

func mitmBidiSplice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
	<-done
	_ = a.Close()
	_ = b.Close()
}

// ─── mitmConnFeed：把已解密的 tls.Conn 当作 net.Listener 喂给 http.Server ───

var errMitmFeedClosed = errors.New("mitm conn feed closed")

type mitmConnFeed struct {
	ch     chan net.Conn
	addr   net.Addr
	closed chan struct{}
	once   sync.Once
}

func newMitmConnFeed(addr net.Addr) *mitmConnFeed {
	return &mitmConnFeed{ch: make(chan net.Conn), addr: addr, closed: make(chan struct{})}
}

func (f *mitmConnFeed) push(c net.Conn) {
	select {
	case f.ch <- c:
	case <-f.closed:
		_ = c.Close()
	}
}

func (f *mitmConnFeed) Accept() (net.Conn, error) {
	select {
	case c := <-f.ch:
		return c, nil
	case <-f.closed:
		return nil, errMitmFeedClosed
	}
}

func (f *mitmConnFeed) Close() error {
	f.once.Do(func() { close(f.closed) })
	return nil
}

func (f *mitmConnFeed) Addr() net.Addr { return f.addr }
