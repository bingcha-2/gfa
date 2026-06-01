package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

const DefaultProxyPort = 60670

// LocalHTTPProxy 本地 HTTP 代理服务器（参考 timo 的 proxy/server.rs）
// 监听 127.0.0.1:{port}，接收 IDE/Hub 的请求并转发到 Google API
type LocalHTTPProxy struct {
	mu         sync.Mutex
	server     *http.Server
	listener   net.Listener
	isRunning  bool
	listenAddr string
	listenPort int
	lastError  string

	// 代理参数
	card          string
	deviceId      string
	upstreamProxy string
}

var globalHTTPProxy = &LocalHTTPProxy{}

func GetHTTPProxy() *LocalHTTPProxy {
	return globalHTTPProxy
}

func (p *LocalHTTPProxy) Start(port int, card, deviceId, upstreamProxy string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.isRunning {
		return nil
	}

	if port <= 0 {
		port = DefaultProxyPort
	}

	p.card = card
	p.deviceId = deviceId
	p.upstreamProxy = upstreamProxy

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.handleRequest(w, r)
	})

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	p.server = &http.Server{
		Handler: handler,
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		p.lastError = err.Error()
		return fmt.Errorf("监听 %s 失败: %w", addr, err)
	}

	p.listener = ln
	p.listenAddr = addr
	p.listenPort = port
	p.isRunning = true
	p.lastError = ""

	go func() {
		Log("[http-proxy] HTTP 代理监听 %s", addr)
		if err := p.server.Serve(ln); err != nil && err != http.ErrServerClosed {
			Log("[http-proxy] Server error: %v", err)
			p.mu.Lock()
			p.isRunning = false
			p.lastError = err.Error()
			p.mu.Unlock()
		}
	}()

	return nil
}

func (p *LocalHTTPProxy) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.isRunning {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if p.server != nil {
		_ = p.server.Shutdown(ctx)
		p.server = nil
	}
	if p.listener != nil {
		_ = p.listener.Close()
		p.listener = nil
	}
	p.isRunning = false
	Log("[http-proxy] Stopped")
}

func (p *LocalHTTPProxy) UpdateConfig(card, deviceId, upstreamProxy string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.card = card
	p.deviceId = deviceId
	p.upstreamProxy = upstreamProxy
}

type HTTPProxyStatus struct {
	Running    bool   `json:"running"`
	ListenAddr string `json:"listenAddr"`
	ListenPort int    `json:"listenPort"`
	LastError  string `json:"lastError"`
}

func (p *LocalHTTPProxy) GetStatus() HTTPProxyStatus {
	p.mu.Lock()
	defer p.mu.Unlock()

	return HTTPProxyStatus{
		Running:    p.isRunning,
		ListenAddr: p.listenAddr,
		ListenPort: p.listenPort,
		LastError:  p.lastError,
	}
}

func (p *LocalHTTPProxy) handleRequest(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	card := p.card
	deviceId := p.deviceId
	upstream := p.upstreamProxy
	p.mu.Unlock()

	path := r.URL.Path

	// /health 端点 - timo 风格的健康检查
	if path == "/health" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
		return
	}

	if isCodexAPIRequest(path) {
		GetCodexProxy().ServeHTTP(w, r, card, deviceId, upstream)
		return
	}

	// 路由逻辑：所有请求都注入我们的 token（与 timo 行为一致）
	// auth/loadCodeAssist/onboardUser 等也需要有效 token
	isGen := isGenerationRequest(path)

	if isGen {
		GetProxy().ServeHTTP(w, r, card, deviceId, false, upstream)
	} else if isModelsRequest(path) {
		// fetchAvailableModels 走 token 注入 + 缓存
		GetProxy().ServeHTTP(w, r, card, deviceId, false, upstream)
	} else {
		// auth/loadCodeAssist/onboardUser 等也注入 token
		GetProxy().ServeHTTP(w, r, card, deviceId, false, upstream)
	}
}
