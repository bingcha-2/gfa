package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// ─── Claude 桌面端 Code/Cowork 接管：MITM 管理器 ────────────────────────────
//
// 把 根CA + MITM代理 + 分派(/v1/messages→ClaudeProxy 换号；其余透传) 粘合起来。
// 与现有明文代理 LocalHTTPProxy(48800) 并存、互不影响：MITM 走独立端口 48801。
//
// 接管(Takeover)流程：装根CA → 起 MITM代理 → 带代理env 重启 Claude.app(route A)。
// 取消(Restore)：停代理 →(可选)卸CA → 重启 Claude.app 还原。
// OS 相关动作(装CA/重启App)见 mitm_os_<goos>.go。

const mitmDefaultPort = 48801

type mitmManager struct {
	mu      sync.Mutex
	proxy   *mitmProxy
	root    *mitmRoot
	port    int
	running bool

	card     string
	deviceId string
	upstream string
}

var globalMitmManager = &mitmManager{}

func GetMitmManager() *mitmManager { return globalMitmManager }

// buildHandler 构造被拦截连接上的请求分派器。
func (m *mitmManager) buildHandler() http.Handler {
	forward := mitmForwardHandler(ANTHROPIC_API_BASE, nil)
	claude := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		card, deviceId, upstream := m.card, m.deviceId, m.upstream
		m.mu.Unlock()
		// 复用现有 Claude 代理：租号池 token → 换 Authorization → 出口闸 → SSE 计费。
		GetClaudeProxy().ServeHTTP(w, r, card, deviceId, upstream)
	})
	return mitmRouter(claude, forward)
}

// StartProxy 仅启动本地 MITM 代理（不装 CA、不重启 App）。
func (m *mitmManager) StartProxy(port int, card, deviceId, upstream string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		m.card, m.deviceId, m.upstream = card, deviceId, upstream
		return nil
	}
	if port <= 0 {
		port = mitmDefaultPort
	}
	root, err := mitmEnsureRoot()
	if err != nil {
		return fmt.Errorf("ensure mitm CA: %w", err)
	}
	m.root = root
	m.card, m.deviceId, m.upstream = card, deviceId, upstream
	m.port = port

	p := newMitmProxy(mitmNewLeafCache(root), m.buildHandler())
	if err := p.Start(fmt.Sprintf("127.0.0.1:%d", port)); err != nil {
		return fmt.Errorf("start mitm proxy: %w", err)
	}
	m.proxy = p
	m.running = true
	Log("[mitm] MITM 代理监听 127.0.0.1:%d (Claude 桌面端 Code/Cowork 接管)", port)
	return nil
}

func (m *mitmManager) StopProxy() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running {
		return
	}
	if m.proxy != nil {
		m.proxy.Stop()
		m.proxy = nil
	}
	m.running = false
	Log("[mitm] MITM 代理已停止")
}

func (m *mitmManager) UpdateConfig(card, deviceId, upstream string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.card, m.deviceId, m.upstream = card, deviceId, upstream
}

func (m *mitmManager) IsProxyRunning() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running
}

func (m *mitmManager) proxyAddr() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	port := m.port
	if port <= 0 {
		port = mitmDefaultPort
	}
	return fmt.Sprintf("127.0.0.1:%d", port)
}

// InstallCA 把本地根 CA 装进系统信任库（OS 相关，需管理员授权）。
func (m *mitmManager) InstallCA() error { return mitmInstallCA(mitmCACertPath()) }

// UninstallCA 从系统信任库移除本地根 CA。
func (m *mitmManager) UninstallCA() error { return mitmUninstallCA() }

// RelaunchClaudeWithProxy 退出并带代理 env 重启 Claude.app（route A：子进程继承走 MITM）。
// 前提：MITM 代理已 StartProxy。成功后落「接管中」标记。
func (m *mitmManager) RelaunchClaudeWithProxy() error {
	if !m.IsProxyRunning() {
		return fmt.Errorf("mitm 代理未启动，无法接管")
	}
	if err := mitmRelaunchClaudeWithProxy(m.proxyAddr(), mitmCACertPath()); err != nil {
		return err
	}
	mitmSetTakeoverActive(true)
	return nil
}

// RelaunchClaudePlain 退出并按原样重启 Claude.app（还原，不带代理），清除「接管中」标记。
func (m *mitmManager) RelaunchClaudePlain() error {
	err := mitmRelaunchClaudePlain()
	mitmSetTakeoverActive(false)
	return err
}

// ── 接管态标记：标记文件存在=已接管。避免还原时强制卸 CA（否则反复弹管理员授权）。──

func mitmMarkerPath() string { return filepath.Join(mitmCADir(), ".takeover_active") }

func mitmSetTakeoverActive(active bool) {
	if active {
		_ = os.MkdirAll(mitmCADir(), 0700)
		_ = os.WriteFile(mitmMarkerPath(), []byte("1"), 0644)
	} else {
		_ = os.Remove(mitmMarkerPath())
	}
}

func mitmIsTakeoverActive() bool {
	_, err := os.Stat(mitmMarkerPath())
	return err == nil
}

type MitmStatus struct {
	Running        bool   `json:"running"`
	Port           int    `json:"port"`
	CAInstalled    bool   `json:"caInstalled"`
	CACertPath     string `json:"caCertPath"`
	TakeoverActive bool   `json:"takeoverActive"`
}

func (m *mitmManager) GetStatus() MitmStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return MitmStatus{
		Running:        m.running,
		Port:           m.port,
		CAInstalled:    mitmIsCAInstalled(),
		CACertPath:     mitmCACertPath(),
		TakeoverActive: mitmIsTakeoverActive(),
	}
}
