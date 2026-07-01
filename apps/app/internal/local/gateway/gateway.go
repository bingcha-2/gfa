// Package gateway 在桌面客户端进程内嵌入 CLIProxyAPI Service,作为本地
// 自有号的多账号网关数据面。生命周期由 supervised goroutine 管理(recover
// 兜底,不让网关崩溃带垮主程序)。
package gateway

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/authsync"
	"bcai-wails/internal/local/routingcfg"
	"bcai-wails/internal/local/stats"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// DefaultGatewayPort 是共享网关的固定默认端口(被占用则回退到下一个空闲端口)。
const DefaultGatewayPort = 8317

type Gateway struct {
	acc     *account.Store
	dataDir string

	mu       sync.Mutex
	svc      *cliproxy.Service
	mgr      *coreauth.Manager
	cancel   context.CancelFunc
	host     string
	port     int
	stats    *stats.Collector
	selector *authsync.Selector // 路由选号器(策略可热切换)
	apiKeys  []string           // 客户端访问 key(写进 CLIProxyAPI api-keys)

	// 运维参数(Wave Q):落地到 CLIProxyAPI config 的超时/重试 + 出口代理。
	streamKeepaliveSeconds int
	streamBootstrapRetries int
	maxRetryCredentials    int
	maxRetryIntervalSec    int
	upstreamProxyURL       string
}

// NewShared 构建反代网关:单实例、单 Service,auth Store 只喂 codex 自有号
//(antigravity 接管走 IDE 注入,见 internal/local/antigravityinject)。
// strategy 是初始路由策略;host 默认仅本机(127.0.0.1),局域网范围经 SetHost 切换。
func NewShared(acc *account.Store, dataDir string, strategy routingcfg.Strategy) *Gateway {
	return &Gateway{
		acc:      acc,
		dataDir:  dataDir,
		host:     "127.0.0.1",
		stats:    stats.NewCollector(),
		selector: authsync.NewSelector(strategy),
	}
}

// SetStrategy 热切换路由策略,立即对后续请求生效(无需重启网关)。
func (g *Gateway) SetStrategy(s routingcfg.Strategy) { g.selector.SetStrategy(s) }

// SetAPIKeys 设置客户端访问 key 列表并重启网关使之生效(若在运行)。
func (g *Gateway) SetAPIKeys(keys []string) error {
	g.mu.Lock()
	g.apiKeys = append([]string(nil), keys...)
	g.mu.Unlock()
	return g.restartIfRunning()
}

// Timeouts 是网关运维超时/重试参数(落地到 CLIProxyAPI config 的子集)。
type Timeouts struct {
	StreamKeepaliveSeconds  int
	StreamBootstrapRetries  int
	MaxRetryCredentials     int
	MaxRetryIntervalSeconds int
}

// SetTimeouts 设置超时/重试参数并重启网关使之生效(若在运行)。
func (g *Gateway) SetTimeouts(t Timeouts) error {
	g.mu.Lock()
	g.streamKeepaliveSeconds = t.StreamKeepaliveSeconds
	g.streamBootstrapRetries = t.StreamBootstrapRetries
	g.maxRetryCredentials = t.MaxRetryCredentials
	g.maxRetryIntervalSec = t.MaxRetryIntervalSeconds
	g.mu.Unlock()
	return g.restartIfRunning()
}

// SetUpstreamProxy 设置出口代理 URL(空=直连)并重启网关使之生效(若在运行)。
// 校验交给上层(gatewaycfg.NormalizeProxyURL);这里只落地并透传给 CLIProxyAPI proxy-url。
func (g *Gateway) SetUpstreamProxy(proxyURL string) error {
	g.mu.Lock()
	g.upstreamProxyURL = proxyURL
	g.mu.Unlock()
	return g.restartIfRunning()
}

// Host 返回当前绑定主机(127.0.0.1=仅本机,0.0.0.0=局域网)。
func (g *Gateway) Host() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.host
}

// SetHost 改绑定主机并重启网关使之生效(若在运行)。仅接受 127.0.0.1/0.0.0.0。
func (g *Gateway) SetHost(host string) error {
	g.mu.Lock()
	g.host = host
	g.mu.Unlock()
	return g.restartIfRunning()
}

// restartIfRunning 在网关运行时停-起一遍,让 cfg(api-keys/host)变更生效。
func (g *Gateway) restartIfRunning() error {
	if !g.Running() {
		return nil
	}
	port := g.Port()
	if err := g.Stop(); err != nil {
		return err
	}
	_, err := g.Start(port)
	return err
}

// yamlStringList 把字符串列表渲染成 yaml 序列项(每行两空格缩进);空列表渲染 "[]"。
func yamlStringList(items []string) string {
	if len(items) == 0 {
		return "  []\n"
	}
	var b strings.Builder
	for _, it := range items {
		fmt.Fprintf(&b, "  - %q\n", it)
	}
	return b.String()
}

func (g *Gateway) newAuthStore() coreauth.Store {
	// 反代网关只服务 codex(antigravity 接管走 IDE 注入,不进网关 auth store)。
	return authsync.NewStore(g.acc, account.ProviderCodex)
}

// Stats 返回网关用量快照(本地统计)。
func (g *Gateway) Stats() stats.Snapshot { return g.stats.Snapshot() }

// Stats0 返回底层统计收集器(供分页查询 / 清空请求日志)。
func (g *Gateway) Stats0() *stats.Collector { return g.stats }

func (g *Gateway) Addr() string { return fmt.Sprintf("%s:%d", g.host, g.port) }

func (g *Gateway) Port() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.port
}

// Start 启动网关。port=0 时自动选空闲端口。返回实际端口。
func (g *Gateway) Start(port int) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.svc != nil {
		return g.port, nil
	}
	if port == 0 {
		p, err := freePort()
		if err != nil {
			return 0, err
		}
		port = p
	} else if !portFree(port) {
		// 指定端口(如固定默认 8317)被占用 → 回退到下一个空闲端口。
		p, err := freePort()
		if err != nil {
			return 0, err
		}
		port = p
	}

	authDir := filepath.Join(g.dataDir, "auth")
	if err := os.MkdirAll(authDir, 0o755); err != nil {
		return 0, err
	}

	cfg := &config.Config{}
	cfg.Host = g.host
	cfg.Port = port
	cfg.AuthDir = authDir // 自有号经自定义 Store 注入;保留目录满足配置/落盘需要
	cfg.APIKeys = append([]string(nil), g.apiKeys...)
	// 运维参数(Wave Q):落地到 CLIProxyAPI config 的超时/重试 + 出口代理。
	cfg.Streaming.KeepAliveSeconds = g.streamKeepaliveSeconds
	cfg.Streaming.BootstrapRetries = g.streamBootstrapRetries
	cfg.MaxRetryCredentials = g.maxRetryCredentials
	cfg.MaxRetryInterval = g.maxRetryIntervalSec
	cfg.ProxyURL = g.upstreamProxyURL // 出口代理:红线之外的自有号数据面出口

	// Build 要求 config path(用于 watcher/reload);写一份最小 yaml 与 cfg 对齐。
	cfgPath := filepath.Join(g.dataDir, "cliproxy.yaml")
	yaml := fmt.Sprintf("host: %q\nport: %d\nauth-dir: %q\napi-keys:\n%s", g.host, port, authDir, yamlStringList(g.apiKeys))
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o600); err != nil {
		return 0, err
	}

	mgr := coreauth.NewManager(g.newAuthStore(), g.selector, nil)
	// Service.Run 不会自动 Load 注入的 manager。用 OnAfterStart 在 server 就绪
	//(executor 已注册)后 Load,确保自有号能正确绑定 codex executor。
	svc, err := cliproxy.NewBuilder().
		WithConfig(cfg).
		WithConfigPath(cfgPath).
		WithCoreAuthManager(mgr).
		WithHooks(cliproxy.Hooks{OnAfterStart: func(*cliproxy.Service) { _ = mgr.Load(context.Background()) }}).
		Build()
	if err != nil {
		return 0, err
	}
	svc.RegisterUsagePlugin(g.stats) // 收集每请求用量(本地统计)

	ctx, cancel := context.WithCancel(context.Background())
	g.svc = svc
	g.mgr = mgr
	g.cancel = cancel
	g.port = port
	go func() {
		defer func() { _ = recover() }() // 兜崩溃,不带垮主程序
		_ = svc.Run(ctx)
	}()
	return port, nil
}

func (g *Gateway) Stop() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.svc == nil {
		return nil
	}
	g.cancel()
	err := g.svc.Shutdown(context.Background())
	g.svc = nil
	g.mgr = nil
	g.cancel = nil
	return err
}

// Reload 让运行中的网关重新从 auth Store 拉取自有号(切换池成员后调用)。
func (g *Gateway) Reload() error {
	g.mu.Lock()
	mgr := g.mgr
	g.mu.Unlock()
	if mgr == nil {
		return nil
	}
	return mgr.Load(context.Background())
}

// SetPort 改反代端口并重启网关(若在运行)。返回实际生效端口
//(指定端口被占用时回退到下一个空闲端口)。
func (g *Gateway) SetPort(port int) (int, error) {
	wasRunning := g.Running()
	if wasRunning {
		if err := g.Stop(); err != nil {
			return 0, err
		}
	}
	if !wasRunning {
		// 未运行时只记录期望端口,下次 Start 生效。
		g.mu.Lock()
		g.port = port
		g.mu.Unlock()
		return port, nil
	}
	return g.Start(port)
}

// LoadedAuthCount 返回网关 auth manager 当前已加载的 auth 数(测试/诊断用)。
func (g *Gateway) LoadedAuthCount() int {
	g.mu.Lock()
	mgr := g.mgr
	g.mu.Unlock()
	if mgr == nil {
		return 0
	}
	return len(mgr.List())
}

func (g *Gateway) Running() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.svc != nil
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// portFree 探测某端口在 127.0.0.1 上是否可绑定。
func portFree(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}
