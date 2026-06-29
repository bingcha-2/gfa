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
	"sync"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/authsync"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

type Gateway struct {
	acc      *account.Store
	provider account.Provider
	dataDir  string

	mu     sync.Mutex
	svc    *cliproxy.Service
	cancel context.CancelFunc
	host   string
	port   int
}

func New(acc *account.Store, p account.Provider, dataDir string) *Gateway {
	return &Gateway{acc: acc, provider: p, dataDir: dataDir, host: "127.0.0.1"}
}

func (g *Gateway) Addr() string { return fmt.Sprintf("%s:%d", g.host, g.port) }

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
	}

	authDir := filepath.Join(g.dataDir, "auth")
	if err := os.MkdirAll(authDir, 0o755); err != nil {
		return 0, err
	}

	cfg := &config.Config{}
	cfg.Host = g.host
	cfg.Port = port
	cfg.AuthDir = authDir // 自有号经自定义 Store 注入;保留目录满足配置/落盘需要

	// Build 要求 config path(用于 watcher/reload);写一份最小 yaml 与 cfg 对齐。
	cfgPath := filepath.Join(g.dataDir, "cliproxy.yaml")
	yaml := fmt.Sprintf("host: %q\nport: %d\nauth-dir: %q\n", g.host, port, authDir)
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o600); err != nil {
		return 0, err
	}

	mgr := coreauth.NewManager(authsync.NewStore(g.acc, g.provider), authsync.Selector{}, nil)
	svc, err := cliproxy.NewBuilder().WithConfig(cfg).WithConfigPath(cfgPath).WithCoreAuthManager(mgr).Build()
	if err != nil {
		return 0, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	g.svc = svc
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
	g.cancel = nil
	return err
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
