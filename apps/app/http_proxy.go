package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const DefaultProxyPort = 48800

// LocalHTTPProxy 本地 HTTP 代理服务器（参考 timo 的 proxy/server.rs）
// 监听 127.0.0.1:{port}，接收 IDE/Hub 的请求并转发到 Google API
type LocalHTTPProxy struct {
	mu         sync.Mutex
	startMu    sync.Mutex // 串行化 Start,避免看门狗/启动/SaveConfig 并发重入重复绑定
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
	// startMu 串行化 Start —— 看门狗、启动、SaveConfig 可能并发调用;字段读写仍走 p.mu。
	p.startMu.Lock()
	defer p.startMu.Unlock()

	p.mu.Lock()
	running := p.isRunning
	p.mu.Unlock()
	if running {
		return nil
	}

	if port <= 0 {
		port = DefaultProxyPort
	}

	// 绑定监听【不持有 p.mu】—— listenWithReclaim 可能重试数秒,持锁会卡住每 2s 的 GetStatus。
	ln, actual, err := bindProxyListener(port)
	if err != nil {
		p.mu.Lock()
		p.lastError = err.Error()
		p.mu.Unlock()
		return fmt.Errorf("监听代理端口失败: %w", err)
	}

	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.handleRequest(w, r)
	})}

	p.mu.Lock()
	p.card = card
	p.deviceId = deviceId
	p.upstreamProxy = upstreamProxy
	p.server = srv
	p.listener = ln
	p.listenAddr = ln.Addr().String()
	p.listenPort = actual
	p.isRunning = true
	p.lastError = ""
	p.mu.Unlock()

	go func() {
		Log("[http-proxy] HTTP 代理监听 127.0.0.1:%d", actual)
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			Log("[http-proxy] Server error: %v", err)
			p.mu.Lock()
			p.isRunning = false
			p.lastError = err.Error()
			p.mu.Unlock()
		}
	}()

	// 端口兜底:绑到了非首选端口(首选被外部程序占着)→ 把已接管、仍指向首选端口的集成
	// 重指到实际端口,否则它们的请求还会发往被占的旧端口、到不了我们。
	if actual != port {
		Log("[http-proxy] ⚠ 首选端口 %d 被占用,已退到 %d", port, actual)
		go reinjectActiveTargets(port, actual)
	}

	return nil
}

// bindProxyListener 绑定代理监听端口:优先首选端口(带本程序残留回收);被外部程序占住时
// 退到一组确定性候选端口(同一占用情形 → 同一备用口 → 注入稳定),仍不行再用系统空闲端口。
// 返回 (监听器, 实际端口, error)。
func bindProxyListener(preferred int) (net.Listener, int, error) {
	ln, err := listenWithReclaim(fmt.Sprintf("127.0.0.1:%d", preferred))
	if err == nil {
		return ln, preferred, nil
	}
	Log("[http-proxy] 首选端口 %d 不可用(%v),尝试备用端口", preferred, err)

	// 确定性候选:首选 +10/+20/…/+90。用 net.Listen(不回收),被占就跳下一个。
	for i := 1; i <= 9; i++ {
		cand := preferred + i*10
		if cand > 65535 {
			break
		}
		if ln, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cand)); e == nil {
			return ln, cand, nil
		}
	}

	// 系统分配的空闲端口兜底。
	if ln, e := net.Listen("tcp", "127.0.0.1:0"); e == nil {
		return ln, ln.Addr().(*net.TCPAddr).Port, nil
	}
	return nil, 0, err
}

// reinjectActiveTargets 在 HTTP 代理退到非首选端口后,把【已接管且仍指向旧端口】的集成
// 重新指到新端口(否则它们的请求仍发往被占的旧端口)。best-effort,逐个容错;不含 mitm 类
// 目标(走独立 48801,与此端口无关)。
func reinjectActiveTargets(oldPort, newPort int) {
	defer func() {
		if r := recover(); r != nil {
			Log("[http-proxy] reinjectActiveTargets panic: %v", r)
		}
	}()
	var moved []string
	for _, t := range takeoverTargets {
		if t.InjectionType() == "mitm" || !t.IsInjected(oldPort) {
			continue
		}
		if _, err := t.Inject(newPort); err != nil {
			Log("[http-proxy] 重指 %s 到端口 %d 失败: %v", t.Name(), newPort, err)
			continue
		}
		moved = append(moved, t.Name())
		Log("[http-proxy] 已把 %s 重指到端口 %d", t.Name(), newPort)
	}
	if len(moved) > 0 {
		setProxyNotice(fmt.Sprintf("端口 %d 被占用,已自动切换到 %d 并重新接管:%s", oldPort, newPort, strings.Join(moved, "、")))
	}
}

// effectiveProxyPort 返回当前应当用于注入/检测的代理端口:代理在跑就用它实际绑定的端口
// (可能因端口兜底而非首选),否则回退到配置里的首选端口。
func effectiveProxyPort() int {
	if st := GetHTTPProxy().GetStatus(); st.Running && st.ListenPort > 0 {
		return st.ListenPort
	}
	return LoadConfig().ProxyPort
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

	// Claude Code(注入 ANTHROPIC_BASE_URL)的生成请求落在 /v1/messages —— 与 codex
	// 的 /v1/responses /v1/chat/completions 不重叠,放在 codex 判断前优先匹配。
	if isClaudeAPIRequest(path) {
		// 本地直连代理入口 = 用户把 Claude Code CLI/IDE 指到这里 → surface=cli。
		GetClaudeProxy().ServeHTTP(w, r, card, deviceId, upstream, "cli")
		return
	}

	if isCodexAPIRequest(path) {
		GetCodexProxy().ServeHTTP(w, r, card, deviceId, upstream, "cli")
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
