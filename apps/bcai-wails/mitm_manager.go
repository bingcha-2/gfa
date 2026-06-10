package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
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

	mockLogin bool // 是否伪造"付费资格"(默认 true：保留真登录，只把订阅改写成 pro)
}

// 默认开启：桌面端接管时把鉴权/资格端点(/api/hello、claude_code/settings、policy_limits)
// 带用户真账号转发到上游，只把 billing_type/subscription 等字段改写成 pro —— 让免费真账号
// 也能过 Code/Cowork 的付费闸、推理走号池。不碰登录态(macOS safeStorage/IPC 原生工作)。
// 上游 401/403(完全未登录)时退回 canned 假 pro 身份(零账号兜底，主要给 Windows/Linux)。
// 运行时可经 SetMockLogin(false) 关掉以完全透传真实资格；重启回到默认 true。
var globalMitmManager = &mitmManager{mockLogin: true}

func GetMitmManager() *mitmManager { return globalMitmManager }

func (m *mitmManager) isMockLogin() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mockLogin
}

// SetMockLogin 开关「付费资格 mock」。默认开：把订阅改写成 pro，让免费真账号也能用号池；
// 关掉则完全透传真实资格。运行时切换即时生效，无需重启代理；重启回到默认 true。
func (m *mitmManager) SetMockLogin(on bool) {
	m.mu.Lock()
	m.mockLogin = on
	m.mu.Unlock()
}

// buildHandler 构造被拦截连接上的请求分派器。
// userProxy 取「用户网络」出口:优先用户前置代理(m.upstream),空则系统代理。
// 请求时实时求值(跟随 UpdateConfig)。用户凭证流量与 passthrough 隧道都经此出口,绝不碰静态 IP。
func (m *mitmManager) userProxy() string {
	m.mu.Lock()
	up := m.upstream
	m.mu.Unlock()
	if up == "" {
		up = getSystemProxy()
	}
	return up
}

func (m *mitmManager) buildHandler() http.Handler {
	// forward/entitlement 按请求凭证选出口:号池 token → 该号静态 IP(无则 fail-closed),
	// 用户自己凭证 → 用户网络。替换原先的 nil(=DefaultTransport 本机直连,会漏号池 token
	// 从本机 IP 出去、与 /v1/messages 的静态 IP 形成同 token 双 IP 跳变)。见 egress_credential.go。
	credTransport := newCredentialAwareTransport(m.userProxy)
	forward := mitmForwardHandler(ANTHROPIC_API_BASE, credTransport)
	claude := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		card, deviceId, upstream := m.card, m.deviceId, m.upstream
		m.mu.Unlock()
		// 复用现有 Claude 代理：租号池 token → 换 Authorization → 出口闸 → SSE 计费。
		GetClaudeProxy().ServeHTTP(w, r, card, deviceId, upstream)
	})
	// 资格端点：mock 开(默认)时转发真请求再把订阅改写成 pro(保留真身份)，关掉则纯透传。
	// 运行时读 m.mockLogin。entitlement handler 内含 401/403 → canned 假 pro 的零账号兜底。
	entitlement := mitmEntitlementHandler(ANTHROPIC_API_BASE, credTransport)
	mockOrForward := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.isMockLogin() {
			entitlement.ServeHTTP(w, r)
		} else {
			forward.ServeHTTP(w, r)
		}
	})
	// 诊断期：把所有非 /v1/messages 的 api.anthropic.com 请求都走 mockOrForward(entitlement)，
	// 这样每个端点(/api/eval、/api/directory 等)的真实响应体都会被打印，便于定位付费墙判定源。
	// entitlement 改写只动 billing 白名单键，对这些端点是 no-op，安全。
	apiRouter := mitmRouter(claude, mockOrForward, mockOrForward)

	// 按 host 分流：claude.ai → utls 解密+订阅改写(掀 UI 付费墙)；其余(api.anthropic.com)→ apiRouter。
	// 必须把出口代理传给 claude.ai handler，否则本机需要系统代理时直连会超时/失败、context canceled。
	// 优先用用户配置的 upstream；没有则取系统代理(Clash/Mihomo 等)；都没有则直连。
	claudeAiProxy := m.upstream
	if claudeAiProxy == "" {
		claudeAiProxy = getSystemProxy()
	}
	claudeAi := mitmClaudeAiHandler(newClaudeUpstreamTransport(claudeAiProxy))
	// 伪造 Code OAuth(authorize/token):把免费号的 Code 授权换成号池 Pro token(方案 B)。
	oauthFake := mitmOAuthFakeHandler(func() (string, error) {
		m.mu.Lock()
		card, dev, up := m.card, m.deviceId, m.upstream
		m.mu.Unlock()
		lease, err := GetClaudeLeaser().LeaseToken(card, dev, false, nil, up)
		if err != nil {
			return "", err
		}
		return lease.AccessToken, nil
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mitmIsClaudeAiHost(r.Host) {
			claudeAi.ServeHTTP(w, r)
			return
		}
		if mitmShouldFakeOAuth(r.URL.Path) {
			oauthFake.ServeHTTP(w, r)
			return
		}
		apiRouter.ServeHTTP(w, r)
	})
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

	p := newMitmProxy(mitmNewLeafCache(root), m.buildHandler(), m.userProxy)
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
	// 伪 credentials.json 注入只对 Windows/Linux 有意义(那边登录态是文件式)。macOS 实测确认
	// Claude 登录态走 safeStorage/钥匙串、根本不读该文件 → 注入是 no-op，跳过避免无谓 churn。
	// mac 走的是 entitlement mock(保留真登录、改写付费资格)，不依赖伪凭证。
	if m.isMockLogin() && runtime.GOOS != "darwin" {
		if err := InjectFakeClaudeCredentials(); err != nil {
			Log("[mitm] 注入伪 credentials.json 失败(不阻塞接管): %v", err)
		}
	}
	// Chromium 渲染进程(登录页/升级墙/主聊天)只信【系统信任库】里的 CA，不认 NODE_EXTRA_CA_CERTS。
	// 要让 entitlement patch 够得着 Chromium 侧的付费墙(它走 --proxy-server 进 MITM)，必须先把根 CA
	// 装进系统钥匙串，否则 Chromium 对 MITM 叶证书报 NET::ERR_CERT_AUTHORITY_INVALID、整个聊天打不开。
	// 已装则跳过(避免每次接管都弹管理员授权框)。
	if !mitmIsCAInstalled() {
		Log("[mitm] 本机信任库未安装根 CA，安装中(Windows 将弹 UAC 管理员授权框 / macOS 弹密码框)…")
		if err := mitmInstallCA(mitmCACertPath()); err != nil {
			Log("[mitm] 安装根 CA 失败(请以管理员运行或在 UAC 框点「是」;否则桌面端订阅等级不会显示 Max): %v", err)
		}
	}
	// 迁移清理:9.2.2 及更早把 CA 装在【当前用户】根存储,现已改用本机库 → 删掉旧的孤儿根,
	// 避免在用户信任库长期残留一张可签名自签根。幂等、不阻塞接管。
	if err := mitmCleanupLegacyUserCA(); err != nil {
		Log("[mitm] 清理遗留的当前用户根 CA 失败(不阻塞): %v", err)
	}
	// ⚠ 闸门:只有 CA【确实被信任】时才给 Chromium 加 --proxy-server。否则 claude.ai(UI 主站)
	// 被 MITM 但叶证书不被信任 → 整页 ERR_CERT_AUTHORITY_INVALID → 桌面端白屏。CA 不可信时退回
	// 「只设 env」:Code/Cowork 的 Node 推理照样走号池,Chromium 直连 claude.ai → UI 正常(仅订阅
	// 等级不会改写成 Max)。这是「白屏」与「无 Max」之间的安全降级,绝不能为了 Max 把界面整白。
	chromiumProxy := mitmIsCAInstalled()
	if !chromiumProxy {
		Log("[mitm] 根 CA 未被信任 → 退回 env-only 重启(Chromium 不走代理,避免白屏;订阅等级暂不会显示 Max,批准证书后重新接管即可)")
	}
	if err := mitmRelaunchClaudeWithProxy(m.proxyAddr(), mitmCACertPath(), chromiumProxy); err != nil {
		return err
	}
	mitmSetTakeoverActive(true)
	return nil
}

// RelaunchClaudePlain 退出并按原样重启 Claude.app（还原，不带代理），清除「接管中」标记。
func (m *mitmManager) RelaunchClaudePlain() error {
	// 还原被伪凭证覆盖的 .credentials.json(无备份则 no-op)。与 mock 开关无关：
	// 只要接管时写过伪凭证，取消时就得还原用户原状态。
	if err := RestoreFakeClaudeCredentials(); err != nil {
		Log("[mitm] 还原 credentials.json 失败(不阻塞还原): %v", err)
	}
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
	MockLogin      bool   `json:"mockLogin"`
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
		MockLogin:      m.mockLogin,
	}
}
